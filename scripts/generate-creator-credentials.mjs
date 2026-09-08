import { randomBytes, scryptSync } from 'node:crypto';

const username = process.argv[2] || 'codestate-creator';
if (!/^[a-z0-9_-]{3,32}$/.test(username)) throw new Error('Use 3 a 32 letras minúsculas, números, _ ou -.');
const password = `Cs!${randomBytes(18).toString('base64url')}9a`;
const salt = randomBytes(32).toString('hex');
const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
process.stdout.write(JSON.stringify({ username, password, passwordHash }, null, 2));
