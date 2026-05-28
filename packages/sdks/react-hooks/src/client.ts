// The typed client lives in the framework-agnostic @oss/sdk-core so other
// framework SDKs (eg a future svelte-sdk) can reuse it. Re-exported here so
// existing `@oss/react-hooks` consumers and internal imports keep working.
export { createClient, contract, type OssClient, type CreateClientOptions } from '@oss/sdk-core';
