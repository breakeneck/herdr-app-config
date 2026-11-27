'use strict';
// Speech to text for the dictation (mic) button. Configured only through the environment
// (the systemd unit's EnvironmentFile, ~/.config/herdr-mobile/env):
//   ASR_PROVIDER  openai (default) | qwen
//   ASR_API_KEY   required; without it the mic button is hidden
//   ASR_MODEL     openai: gpt-transcribe; qwen: qwen-audio-3.0-asr-flash
//   ASR_URL       openai: https://api.openai.com/v1/audio/transcriptions;
//                 qwen: Alibaba Token Plan multimodal-generation endpoint
//   ASR_LANGUAGE  optional ISO-639-1 hint (e.g. uk); openai only. Without it gpt-transcribe can
//                 mistake short Ukrainian phrases for other languages.
const PROVIDERS = {
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-transcribe', run: openai },
  qwen: { url: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', model: 'qwen-audio-3.0-asr-flash', run: qwen },
};

const cfg = () => {
  const name = (process.env.ASR_PROVIDER || 'openai').trim().toLowerCase();
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown ASR_PROVIDER: ${name}`);
  return { p, key: (process.env.ASR_API_KEY || '').trim(), url: process.env.ASR_URL || p.url, model: process.env.ASR_MODEL || p.model,
    language: (process.env.ASR_LANGUAGE || '').trim() };
};
const enabled = () => { try { return Boolean(cfg().key); } catch { return false; } };

// Browser recordings: Chrome/Firefox give audio/webm (opus), Safari audio/mp4.
const FORMATS = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/amr': 'amr', 'video/webm': 'webm', 'video/mp4': 'mp4' };

// Browser recordings are often malformed for the ASR APIs: MediaRecorder webm has no duration and its
// timestamps can start late, Safari's fragmented mp4 needs a seekable file. So every recording is
// re-encoded with ffmpeg to plain 16 kHz mono mp3 (if ffmpeg fails, the original is sent).
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');
const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { timeout: 60000, maxBuffer: 1e6 }, (e, out, err) => (e ? no(new Error(String(err || e.message).slice(-300))) : ok(String(out)))));
async function normalize(buf, fmt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-asr-'));
  const src = path.join(dir, 'in.' + fmt), dst = path.join(dir, 'out.mp3');
  try {
    fs.writeFileSync(src, buf);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', dst]);
    const secs = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', dst]));
    return { buf: fs.readFileSync(dst), secs: Number.isFinite(secs) ? secs : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The last few recordings that came back empty or failed are kept for a look
// (~/.config/herdr-mobile/asr-failed/, newest 5).
const FAILED = path.join(process.env.HERDR_MOBILE_HOME || path.join(os.homedir(), '.config', 'herdr-mobile'), 'asr-failed');
function keepFailed(buf, fmt) {
  try {
    fs.mkdirSync(FAILED, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(FAILED, `${new Date().toISOString().replace(/[:.]/g, '-')}.${fmt}`), buf, { mode: 0o600 });
    const old = fs.readdirSync(FAILED).sort().slice(0, -5);
    for (const f of old) fs.rmSync(path.join(FAILED, f), { force: true });
  } catch {}
}

async function transcribe(buf, mime) {
  const c = cfg();
  if (!c.key) throw new Error('Dictation is not configured (ASR_API_KEY)');
  const type = String(mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const fmt = FORMATS[type] || type.split('/')[1] || 'webm';
  const t0 = Date.now();
  let audio = { buf, type, fmt, secs: null }, note = '';
  try { const n = await normalize(buf, fmt); audio = { buf: n.buf, type: 'audio/mpeg', fmt: 'mp3', secs: n.secs }; }
  catch (e) { note = ` (ffmpeg failed, sent as is: ${e.message.trim()})`; }
  const log = (what) => console.log(`asr: ${type} ${buf.length} B, ${audio.secs == null ? '?' : audio.secs.toFixed(1)} s -> ${what}, ${Date.now() - t0} ms${note}`);
  if (audio.secs != null && audio.secs < 0.3) { log('too short'); keepFailed(buf, fmt); throw new Error('Recording is empty (no audio reached the server)'); }
  let text;
  try { text = String(await c.p.run(c, audio.buf, audio.type, audio.fmt) || '').trim(); }
  catch (e) { log('error: ' + e.message); keepFailed(buf, fmt); throw e; }
  log(text ? `${text.length} chars` : 'empty');
  if (!text) keepFailed(buf, fmt);
  return text;
}

async function call(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
  const raw = await r.text();
  let d; try { d = JSON.parse(raw); } catch { throw new Error(`ASR HTTP ${r.status}: ${raw.slice(0, 200)}`); }
  const err = d.error ? (d.error.message || d.error) : d.code && d.message;
  if (!r.ok || err) throw new Error(`ASR: ${err || 'HTTP ' + r.status}`);
  return d;
}

let chunking = true;
async function openai(c, buf, type, fmt) {
  const form = new FormData();
  form.append('model', c.model);
  if (c.language) form.append('language', c.language);
  // Long recordings: let the server cut them at pauses (VAD) instead of returning nothing or a cut text.
  if (chunking) form.append('chunking_strategy', 'auto');
  form.append('file', new Blob([buf], { type }), `speech.${fmt}`);
  try {
    const d = await call(c.url, { method: 'POST', headers: { authorization: `Bearer ${c.key}` }, body: form });
    return d.text;
  } catch (e) {
    // a model or endpoint without chunking_strategy: drop it from now on
    if (chunking && /chunking/i.test(e.message)) { chunking = false; return openai(c, buf, type, fmt); }
    throw e;
  }
}

async function qwen(c, buf, type, fmt) {
  const d = await call(c.url, { method: 'POST', headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: c.model,
      input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${type};base64,${buf.toString('base64')}` } }] }] },
      parameters: { format: fmt },
    }) });
  const msg = d.output && d.output.choices && d.output.choices[0] && d.output.choices[0].message;
  const parts = msg && Array.isArray(msg.content) ? msg.content.map((x) => x.text || '').join('') : (msg && msg.content) || '';
  return parts || (d.sentence && d.sentence.text) || (d.output && d.output.text) || '';
}

module.exports = { enabled, transcribe };
