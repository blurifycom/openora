// Ports (interfaces) for third-party adapters.
// Implementations live in adapters/<vendor>/ and are injected via Nest DI.
//
// Example:
// export interface {{Name}}Provider {
//   create(input: {{Name}}Input): Promise<{{Name}}>;
// }
//
// export const {{NAME_UPPER}}_PROVIDER = Symbol('{{NAME_UPPER}}_PROVIDER');
