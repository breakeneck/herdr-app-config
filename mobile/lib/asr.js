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

async function transcribe(buf, mime) {
  const c = cfg();
  if (!c.key) throw new Error('Dictation is not configured (ASR_API_KEY)');
  const type = String(mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const fmt = FORMATS[type] || type.split('/')[1] || 'webm';
  return String(await c.p.run(c, buf, type, fmt) || '').trim();
}

async function call(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
  const raw = await r.text();
  let d; try { d = JSON.parse(raw); } catch { throw new Error(`ASR HTTP ${r.status}: ${raw.slice(0, 200)}`); }
  const err = d.error ? (d.error.message || d.error) : d.code && d.message;
  if (!r.ok || err) throw new Error(`ASR: ${err || 'HTTP ' + r.status}`);
  return d;
}

async function openai(c, buf, type, fmt) {
  const form = new FormData();
  form.append('model', c.model);
  if (c.language) form.append('language', c.language);
  form.append('file', new Blob([buf], { type }), `speech.${fmt}`);
  const d = await call(c.url, { method: 'POST', headers: { authorization: `Bearer ${c.key}` }, body: form });
  return d.text;
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
