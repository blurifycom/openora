#!/usr/bin/env node
import { main } from '../dist/audit/service/audit-copy.service.js';

process.exitCode = await main(process.argv.slice(2), process.env);
