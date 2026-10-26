import { INBOUND_KEY, PASS, TWITCH_KEY, YT_KEY } from './config';

// FFmpeg names its input and outputs by their full URL, keys and all, so
// they're hidden in everything printed, since the logs are shown elsewhere
const SECRETS = [INBOUND_KEY, PASS, TWITCH_KEY, YT_KEY].filter(
  (key): key is string => !!key,
);
export function hide(text: string) {
  return SECRETS.reduce((out, key) => out.replaceAll(key, '***'), text);
}
export function log(text: string) {
  process.stdout.write(hide(text.endsWith('\n') ? text : `${text}\n`));
}
