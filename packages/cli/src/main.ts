#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { NebulaClient } from '@nebula/client';
import { run } from './cli';
import { FileSessionStore } from './session-store';

/** process 배선만 — 로직은 전부 run()에 (테스트 진입점) */
async function main(): Promise<void> {
  const sessionPath =
    process.env.NEBULA_SESSION_FILE ?? join(homedir(), '.nebula', 'session.json');
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    createClient: (options) => new NebulaClient(options),
    session: new FileSessionStore(sessionPath),
    saveFile: (path, data) => writeFileSync(path, data),
  });
}

void main();
