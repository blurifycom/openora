import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { session, user, verification } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  capturedEmailsFor,
  closeE2e,
  registrationRequestHeaders,
  uniqueUsername,
  verificationOtpFor,
  waitForEmail,
} from '../index.js';
import {
  ErrorBodySchema,
  LoginSuccessSchema,
  PASSWORD,
  bootIdentityE2e,
  login,
  newCredentialPlayer,
  postJson,
  uniqueEmail,
  type IdentityE2e,
} from './support/identity.js';

let e2e: IdentityE2e;

beforeAll(async () => {
  e2e = await bootIdentityE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

const CheckEmailSchema = z.object({ status: z.literal('check-email') });
const AvailabilitySchema = z.object({ available: z.boolean() });
const VerifiedSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }),
  session: z.object({ token: z.string() }),
});

type RegistrationBody = {
  email: string;
  password?: string;
  username?: string;
  acceptedTerms?: boolean;
  acceptedAge?: boolean;
};

const register = (body: RegistrationBody) =>
  postJson(e2e, '/identity/register', {
    password: 'registration-pass-12',
    username: uniqueUsername('reg'),
    acceptedTerms: true,
    acceptedAge: true,
    ...body,
  });

const verifyEmail = (email: string, otp: string) =>
  postJson(e2e, '/identity/email/verify', { email, otp });

async function usersByEmail(email: string) {
  return db()
    .select()
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.toLowerCase()));
}

async function userByEmail(email: string) {
  const [row] = await usersByEmail(email);
  if (!row) {
    throw new Error(`no user for ${email}`);
  }
  return row;
}

async function sessionCount(userId: string) {
  return (await db().select().from(session).where(eq(session.userId, userId))).length;
}

async function expireCodesFor(email: string) {
  await db()
    .update(verification)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(like(verification.identifier, `%${email.toLowerCase()}%`));
}

const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

async function getAvailability(username: string) {
  const res = await e2e.app.app.request(`/identity/username-available?username=${username}`, {
    method: 'GET',
    headers: registrationRequestHeaders(),
  });
  const body: unknown = await res.json();
  return { status: res.status, body };
}

describe('player registration', () => {
  it('a visitor registers with a 12 character password, age 18 or over and terms accepted and receives a player account with an unverified email', async () => {
    const email = uniqueEmail('reg-ok');

    const res = await register({ email, password: '123456789012' });

    expect(res.status).toBe(200);
    expect(CheckEmailSchema.parse(res.body).status).toBe('check-email');
    const account = await userByEmail(email);
    expect(account.emailVerified).toBe(false);
    expect(account.role).toBe('player');
    expect(await sessionCount(account.id)).toBe(0);
    const [profile] = await db().select().from(player).where(eq(player.userId, account.id));
    expect(profile?.termsVersion).toBe('test-v1');
    expect(profile?.termsAcceptedAt).toBeInstanceOf(Date);
    expect(profile?.ageAcceptedAt).toBeInstanceOf(Date);
  });

  it('registration with a password of 11 characters is refused with a validation error and creates no user row', async () => {
    const email = uniqueEmail('reg-short');

    const res = await register({ email, password: '12345678901' });

    expect(res.status).toBe(400);
    expect(ErrorBodySchema.parse(res.body).code).toBe('BAD_REQUEST');
    expect(await usersByEmail(email)).toEqual([]);
  });

  it('registration without accepted terms is refused and creates no user row', async () => {
    const declined = uniqueEmail('reg-terms-false');
    const missing = uniqueEmail('reg-terms-missing');

    const refused = await register({ email: declined, acceptedTerms: false });
    const absent = await postJson(e2e, '/identity/register', {
      email: missing,
      password: 'registration-pass-12',
      username: uniqueUsername('reg'),
      acceptedAge: true,
    });

    expect(refused.status).toBe(400);
    expect(absent.status).toBe(400);
    expect(await usersByEmail(declined)).toEqual([]);
    expect(await usersByEmail(missing)).toEqual([]);
  });

  it.todo(
    'GAP: registration takes no birth date, only the acceptedAge attestation, so an under-18 date cannot be refused (packages/core/src/contracts/schemas/identity.ts:182)',
  );
  it.todo(
    'GAP: registration takes no birth date, so the exactly-18 boundary has no input to test (packages/core/src/contracts/schemas/identity.ts:182)',
  );

  it('registering an email that already exists returns the same neutral result as a fresh email and creates no second account', async () => {
    const email = uniqueEmail('reg-dup');
    const first = await register({ email, username: uniqueUsername('first') });
    const original = await userByEmail(email);
    const secondUsername = uniqueUsername('second');

    const duplicate = await register({ email, username: secondUsername });
    const fresh = await register({ email: uniqueEmail('reg-fresh') });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(fresh.status);
    expect(duplicate.body).toEqual(fresh.body);
    expect(await usersByEmail(email)).toHaveLength(1);
    expect((await userByEmail(email)).username).toBe(original.username);
    expect(
      await db()
        .select()
        .from(user)
        .where(eq(sql`lower(${user.username})`, secondUsername)),
    ).toEqual([]);
  });

  it('simultaneous registrations of one email create a single account and answer alike', async () => {
    const email = uniqueEmail('reg-race');

    const results = await Promise.all(
      [1, 2, 3].map((n) => register({ email, username: uniqueUsername(`race${n}`) })),
    );

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(CheckEmailSchema.parse(result.body).status).toBe('check-email');
    }
    expect(await usersByEmail(email)).toHaveLength(1);
  });

  it('simultaneous registrations of one username create a single account and the loser gets a conflict', async () => {
    const username = uniqueUsername('uname');

    const results = await Promise.all(
      [1, 2, 3].map((n) => register({ email: uniqueEmail(`reg-uname${n}`), username })),
    );

    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(
      await db()
        .select()
        .from(user)
        .where(eq(sql`lower(${user.username})`, username)),
    ).toHaveLength(1);
  });

  it('registering an email differing only by letter case does not create a second account', async () => {
    const email = uniqueEmail('reg-case');
    await register({ email });

    const shouty = await register({ email: email.toUpperCase(), username: uniqueUsername('case') });

    expect(shouty.status).toBe(200);
    expect(CheckEmailSchema.parse(shouty.body).status).toBe('check-email');
    expect(await usersByEmail(email)).toHaveLength(1);
  });

  it('registering a reserved or blocked username is refused', async () => {
    for (const username of ['admin', 'support_7', 'Official']) {
      const email = uniqueEmail('reg-reserved');

      const res = await register({ email, username });

      expect(res.status, username).toBe(400);
      expect(ErrorBodySchema.parse(res.body).data).toMatchObject({ field: 'username' });
      expect(await usersByEmail(email), username).toEqual([]);
    }
  });

  it.todo(
    'GAP: registration takes no language field; unsupported languages are refused only by updateProfile (packages/core/src/contracts/schemas/identity.ts:182, packages/core/src/pam/shared/language.ts:8)',
  );

  it('username availability reports a taken username as unavailable and a free one as available', async () => {
    const taken = uniqueUsername('taken');
    await register({ email: uniqueEmail('reg-taken'), username: taken });

    const takenResult = await getAvailability(taken);
    const shoutedResult = await getAvailability(taken.toUpperCase());
    const freeResult = await getAvailability(uniqueUsername('free'));
    const reservedResult = await getAvailability('admin');

    expect(takenResult.status).toBe(200);
    expect(AvailabilitySchema.parse(takenResult.body).available).toBe(false);
    expect(AvailabilitySchema.parse(shoutedResult.body).available).toBe(false);
    expect(AvailabilitySchema.parse(freeResult.body).available).toBe(true);
    expect(AvailabilitySchema.parse(reservedResult.body).available).toBe(false);
  });

  it('a new player receives a verification email carrying a single use code', async () => {
    const email = uniqueEmail('reg-mail');
    await register({ email });

    const code = await verificationOtpFor(email);

    expect(code).toMatch(/^\d{6}$/);
    const mails = capturedEmailsFor(email).filter((mail) => /verify/i.test(mail.subject));
    expect(mails).toHaveLength(1);
    expect(mails[0]?.text).toContain(code);
    const pending = await db()
      .select()
      .from(verification)
      .where(like(verification.identifier, `%${email}%`));
    expect(pending).toHaveLength(1);

    expect((await verifyEmail(email, code)).status).toBe(200);
    expect(
      await db()
        .select()
        .from(verification)
        .where(like(verification.identifier, `%${email}%`)),
    ).toEqual([]);
  });
});

describe('email verification', () => {
  it('a player confirms the emailed code and the account becomes email verified', async () => {
    const email = uniqueEmail('ver-ok');
    await register({ email });
    expect((await userByEmail(email)).emailVerified).toBe(false);

    const res = await verifyEmail(email, await verificationOtpFor(email));

    expect(res.status).toBe(200);
    const body = VerifiedSchema.parse(res.body);
    expect(body.user.emailVerified).toBe(true);
    const account = await userByEmail(email);
    expect(account.emailVerified).toBe(true);
    expect(await sessionCount(account.id)).toBe(1);
    expect(
      LoginSuccessSchema.safeParse((await login(e2e, email, 'registration-pass-12')).body).success,
    ).toBe(true);
  });

  it('a wrong code is refused and leaves the email unverified', async () => {
    const email = uniqueEmail('ver-wrong');
    await register({ email });
    const code = await verificationOtpFor(email);

    const res = await verifyEmail(email, wrongCode(code));

    expect(res.status).toBe(400);
    const account = await userByEmail(email);
    expect(account.emailVerified).toBe(false);
    expect(await sessionCount(account.id)).toBe(0);
  });

  it('an expired code is refused', async () => {
    const email = uniqueEmail('ver-expired');
    await register({ email });
    const code = await verificationOtpFor(email);
    await expireCodesFor(email);

    const res = await verifyEmail(email, code);

    expect(res.status).toBe(400);
    const account = await userByEmail(email);
    expect(account.emailVerified).toBe(false);
    expect(await sessionCount(account.id)).toBe(0);
  });

  it('a used code cannot be confirmed a second time', async () => {
    const email = uniqueEmail('ver-reuse');
    await register({ email });
    const code = await verificationOtpFor(email);
    expect((await verifyEmail(email, code)).status).toBe(200);
    const account = await userByEmail(email);
    const sessionsAfterFirst = await sessionCount(account.id);

    const again = await verifyEmail(email, code);

    expect(again.status).toBe(400);
    expect(await sessionCount(account.id)).toBe(sessionsAfterFirst);
  });

  it('sending verification codes repeatedly is rate limited', async () => {
    const email = uniqueEmail('ver-rate');
    await register({ email });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await postJson(e2e, '/identity/email/verify/send', { email })).status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('a player cannot verify the email of another player with their own code', async () => {
    const owner = uniqueEmail('ver-owner');
    const victim = uniqueEmail('ver-victim');
    await register({ email: owner });
    await register({ email: victim });
    const ownerCode = await verificationOtpFor(owner);
    const victimCode = await verificationOtpFor(victim);
    if (ownerCode === victimCode) {
      throw new Error('codes collided, rerun');
    }

    const res = await verifyEmail(victim, ownerCode);

    expect(res.status).toBe(400);
    expect((await userByEmail(victim)).emailVerified).toBe(false);
    expect((await verifyEmail(owner, ownerCode)).status).toBe(200);
    expect((await userByEmail(victim)).emailVerified).toBe(false);
  });
});

describe('email change', () => {
  const codeSentTo = async (email: string) => {
    const mail = await waitForEmail(email, () => true);
    const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
    if (!code) {
      throw new Error(`no code in mail for ${email}`);
    }
    return code;
  };

  it('a signed-in player requests an email change and confirms it with the code sent to the new address', async () => {
    const account = await newCredentialPlayer(e2e, 'chg-ok');
    const newEmail = uniqueEmail('chg-new');

    const requested = await account.client.post('/identity/email/change/request', {
      newEmail,
      currentPassword: PASSWORD,
    });
    expect(requested.status).toBe(200);
    expect((await userByEmail(account.email)).id).toBe(account.userId);

    const confirmed = await account.client.post('/identity/email/change/confirm', {
      newEmail,
      otp: await codeSentTo(newEmail),
    });

    expect(confirmed.status).toBe(200);
    expect((await userByEmail(newEmail)).id).toBe(account.userId);
    expect(await usersByEmail(account.email)).toEqual([]);
    expect((await login(e2e, newEmail, PASSWORD)).status).toBe(200);
    expect((await login(e2e, account.email, PASSWORD)).status).toBe(401);
  });

  it('confirming an email change with a code issued for another player is refused', async () => {
    const victim = await newCredentialPlayer(e2e, 'chg-victim');
    const attacker = await newCredentialPlayer(e2e, 'chg-attacker');
    const victimNew = uniqueEmail('chg-victim-new');
    const attackerNew = uniqueEmail('chg-attacker-new');
    await victim.client.post('/identity/email/change/request', {
      newEmail: victimNew,
      currentPassword: PASSWORD,
    });
    await attacker.client.post('/identity/email/change/request', {
      newEmail: attackerNew,
      currentPassword: PASSWORD,
    });
    const victimCode = await codeSentTo(victimNew);
    const attackerCode = await codeSentTo(attackerNew);
    if (victimCode === attackerCode) {
      throw new Error('codes collided, rerun');
    }

    const stolenForOwnAddress = await attacker.client.post('/identity/email/change/confirm', {
      newEmail: attackerNew,
      otp: victimCode,
    });
    const stolenForVictimAddress = await attacker.client.post('/identity/email/change/confirm', {
      newEmail: victimNew,
      otp: victimCode,
    });

    expect(stolenForOwnAddress.status).toBe(400);
    expect(stolenForVictimAddress.status).toBe(400);
    expect((await userByEmail(attacker.email)).id).toBe(attacker.userId);
    expect((await userByEmail(victim.email)).id).toBe(victim.userId);
    expect(await usersByEmail(attackerNew)).toEqual([]);
    expect(await usersByEmail(victimNew)).toEqual([]);
  });

  it('an anonymous caller cannot request an email change', async () => {
    const owner = await newCredentialPlayer(e2e, 'chg-anon');
    const newEmail = uniqueEmail('chg-anon-new');

    const res = await postJson(e2e, '/identity/email/change/request', {
      newEmail,
      currentPassword: PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(
      await db()
        .select()
        .from(verification)
        .where(like(verification.identifier, `%${newEmail}%`)),
    ).toEqual([]);
    expect(capturedEmailsFor(newEmail)).toEqual([]);
    expect((await userByEmail(owner.email)).id).toBe(owner.userId);
  });
});
