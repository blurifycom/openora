#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
// oxlint-disable no-console
import { buildDepGraph } from './dep-graph.js';

const out = process.argv[2] ?? 'dep-graph.json';
const graph = buildDepGraph(process.cwd());
writeFileSync(out, JSON.stringify(graph));
console.log(
  `${out}: ${Object.keys(graph.dependents).length} files with importers, ` +
    `${Object.keys(graph.entryPoints).length} entry points`,
);
