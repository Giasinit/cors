import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Vercel's Go builder runs `go mod tidy` from the project root after npm install.
// A module boundary stops Go from scanning Go sources shipped by npm packages
// (notably node_modules/@vercel/go/dist, an invalid Go import path).
const directory = fileURLToPath(new URL('../node_modules/', import.meta.url));
mkdirSync(directory, { recursive: true });
writeFileSync(directory + '/go.mod', 'module cors-npm-dependencies\n\ngo 1.22\n');
