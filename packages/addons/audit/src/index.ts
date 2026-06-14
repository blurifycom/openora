// Public surface of the Audit module. Export only what other packages
// may consume; internal implementation details stay private. Cross-module table
// reads go through the `@oss-addons/audit/schema` subpath.
export { AuditService } from './service/audit.service.js';
