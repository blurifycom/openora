import { oc } from '@orpc/contract';
import * as z from 'zod';

export const healthContract = {
  ping: oc
    .route({ method: 'GET', path: '/health' })
    .output(z.object({ status: z.literal('ok'), timestamp: z.string() })),
};
