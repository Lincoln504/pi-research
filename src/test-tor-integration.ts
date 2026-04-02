import * as path from 'node:path';
import * as fs from 'node:fs';

async function generateTorSettings() {
  const EXTENSION_DIR = path.resolve();
  const defaultSettingsPath = path.join(EXTENSION_DIR, 'config', 'default-settings.yml');
  const torSettingsPath = path.join(EXTENSION_DIR, 'config', 'tor-settings-generated.yml');
  const HOST_IP = '10.0.0.59'; // host.docker.internal on Linux Docker
  const TOR_SOCKS_PORT = 9150;
  
  console.log('=== Tor Settings Test (with Host IP) ===');
  console.log('Host IP:', HOST_IP);
  console.log('Tor Port:', TOR_SOCKS_PORT);
  
  const defaultSettings = await fs.promises.readFile(defaultSettingsPath, 'utf-8');
  
  const yaml = (await import('js-yaml')).default;
  const settings = yaml.load(defaultSettings);
  
  settings.outgoing = settings.outgoing || {};
  settings.outgoing.proxies = {
    'all://': [`socks5://${HOST_IP}:${TOR_SOCKS_PORT}`]
  };
  settings.outgoing.using_tor_proxy = true;
  settings.outgoing.extra_proxy_timeout = 10;
  
  console.log('Proxy URL:', settings.outgoing.proxies['all://'][0]);
  
  const generatedSettings = yaml.dump(settings);
  await fs.promises.writeFile(torSettingsPath, generatedSettings, 'utf-8');
  
  console.log('✓ Generated:', torSettingsPath);
  
  const verify = await fs.promises.readFile(torSettingsPath, 'utf-8');
  console.log('Proxy in file:', verify.includes('socks5://10.0.0.59:9150') ? '✓' : '✗');
}

generateTorSettings().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
