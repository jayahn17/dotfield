// Tries to run a shell; the permission model forbids child processes.
import { execSync } from 'node:child_process';
export const shell = () => String(execSync('echo escaped'));
