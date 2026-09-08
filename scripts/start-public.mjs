import { createApp } from '../server.mjs';

const publicUrl = process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL;
if (!publicUrl) throw new Error('A hospedagem precisa informar PUBLIC_APP_URL ou RENDER_EXTERNAL_URL.');

process.env.PUBLIC_APP_URL = publicUrl;
process.env.APP_ORIGIN = publicUrl;
process.env.HOST = '0.0.0.0';
process.env.NODE_ENV = 'production';

const app = createApp();
const port = Number(process.env.PORT || 10000);
app.server.listen(port, '0.0.0.0', () => console.log(`CodeState público em ${publicUrl}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => app.close().then(() => process.exit(0)));
}
