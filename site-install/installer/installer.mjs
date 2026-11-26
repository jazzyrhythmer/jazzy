import {mountConsent,requireConsent,downloadBackup,ready as consentReady} from './start-consent.mjs?v=20261126.1';
mountConsent();
import {fetchChecked} from './network.mjs?v=installer-20261126.1';
import {INSTALLER_REVISION,validateOfficial,recoveryPolicy,stockName,deviceSummary,environment,failureDetails} from './install-safety.mjs?v=installer-20261126.1';
// SPDX-License-Identifier: GPL-3.0-only
import {UniqueUpdater} from './discovery.mjs?v=installer-20261126.3';
import { BackupConnection, captureBackup } from './fm1backup.js?v=installer-20261126.1';
import { isSupportedSource, requireCheck, validateTarget } from './package.mjs?v=installer-20261126.1';
import { mountProgress } from './progress.mjs?v=installer-20261126.1';

const el = id => document.getElementById(id);
const mode = new URLSearchParams(location.search).get('mode') === 'stock' ? 'stock' : 'jazzy';
const checkpointKey = 'jazzy-local-install-sha256';
const progress = mountProgress(el('transfer-status'));
const dialog = el('confirm');
const events = [];
const checks = ['confirm-backup', 'confirm-risk', 'confirm-notice'];
if (mode === 'jazzy') checks.push('confirm-v15', 'confirm-audio');
const backupLabel = el('backup-label').textContent;
let manifest, target, recovery, source, up, access, officialOverride=null, lastError=null, inspectedDevice=null, releaseLock, heartbeat, channel;
let archiveURL, reportURL, working = false, writing = false, lastStage;
document.body.dataset.mode = mode;

function log(message) {
  events.push({ time: new Date().toISOString(), message });
  el('log').textContent = events.map(entry => entry.time.slice(11, 19) + ' ' + entry.message).join('\n');
  el('log').scrollTop = el('log').scrollHeight;
}
function status(message) {
  el('result').textContent = message;
  log(message);
}
function refresh() {
  const ready = !!(target && recovery) && el('stock-version').value===recovery.product;
  el('start').disabled = working || !ready || !consentReady();
  el('connect').disabled = working || !ready || !!source;
  el('disconnect').disabled = working || !source;
  el('backup').disabled = working || !source?.name;
  el('backup-saved').disabled = working || !source || !!source.name && !archiveURL;
  el('review-risk').disabled = working || !ready;
  el('review').disabled = working || !source || !ready;
  el('stock-file').disabled = working;el('stock-version').disabled=working;
}
async function run(action) {
  if (working) return;
  working = true;
  refresh();
  try {
    await action();
  } catch (e) {
    if (['running', 'waiting'].includes(progress.model.status)) progress.fail(e.message);
    e.lastRequest=up?.lastRequest??null;e.portScan=up?.lastScan??null;lastError=failureDetails(e,{mode,target,stage:lastStage,writing});status('Stopped: ' + e.message + ' '+lastError.advice+ (writing ? ' Inspect the device before retrying.' : ' This action did not start a device write.'));
  } finally {
    working = writing = false;
    refresh();
  }
}

async function read(url) {
  const response = await fetchChecked(url, { cache: 'no-store' });
  requireCheck(response.ok, 'Download unavailable: ' + url);
  return response;
}
async function checkedPackage(meta, kind) {
  return validateTarget(new Uint8Array(await (await read(meta.url)).arrayBuffer()), meta, kind);
}
async function preload() {
  manifest = await (await read('manifest.json')).json();
  recovery = officialOverride || await checkedPackage(manifest.stock, 'stock');
  el('stock-status').textContent = 'READY / '+stockName(recovery.product)+': exact size, package and SHA-256 verified.';
  target = mode === 'stock' ? recovery : await checkedPackage(manifest.jazzy, 'jazzy');
  el('build-status').textContent = mode === 'stock'
    ? 'READY / Target firmware: '+stockName(recovery.product)+' ('+recovery.product+').'
    : `READY / Target firmware: JAZZY v0.1.0-beta.1 · build ${manifest.jazzy.build} (FM-1_900). Both embedded Break banks verified.`;
  log('Target firmware and official V15 recovery verified.');
}

const same = (a, b) => a.id === b.id && a.input.id === b.input.id && a.output.id === b.output.id;
class ReviewedUpdater extends UniqueUpdater {
  async find(filter, options) {
    const found = await super.find(filter, { ...options, others: false });
    if (found && this.expected) {
      const checked = this.expected;
      this.expected = undefined;
      if (!same(checked, { id: found.id.text, input: found.link.input, output: found.link.output })) {
        found.link.close();
        throw new Error('The FM-1 changed after review. Reconnect and back up again.');
      }
    }
    return found;
  }
  async write(ota, image, step) {
    step('write-start', ota.id.text);
    return super.write(ota, image, step);
  }
}

async function identify() {
  const device = await up.find(() => true, { tries: 1 });
  requireCheck(device, 'No responding FM-1. Check the data cable and USB Device mode.');
  const { input, output } = device.link;
  const id = device.id.text;inspectedDevice=deviceSummary({id,input,output,kind:'unclassified'});
  device.link.close();
  if (device.id.model === 'ota-FM-1') {
    requireCheck(mode === 'stock' || localStorage.getItem(checkpointKey) === target.sha256,
      'The loader has no matching JAZZY checkpoint. Open the original installer or use Official V15 recovery.');
    return { id, name: '', input, output, resume: true };
  }
  let name = '';
  if (id !== 'FM-1_015' && id !== 'FM-1_016') {
    const link = new BackupConnection(input, output);
    try {
      const info = await link.request([1, []], { timeout: 1800, retries: 1 });
      name = String.fromCharCode(...info.slice(0, info.indexOf(0)));
    } finally { link.close(); }
  }
  requireCheck(isSupportedSource(id, name, mode), 'Unsupported starting firmware for this target. Back up with its editor and start from official V15 or V16.');
  return { id, name, input, output };
}
function clearArchive() {
  if (archiveURL) URL.revokeObjectURL(archiveURL);
  archiveURL = undefined;
  el('backup-download').hidden = true;
  el('backup-saved').checked = false;
}
function disconnect() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  channel?.postMessage({ type: 'installer', busy: false });
  channel?.close();
  channel = undefined;
  up?.close();
  releaseLock?.();
  releaseLock = undefined;
  access = up = source = undefined;
  clearArchive();
  el('backup-label').textContent = backupLabel;
  el('review-risk').checked = false;
  el('device-status').textContent = 'Not connected.';
  el('backup-status').textContent = 'Inspect the device first.';
}
async function connect() {
  requireCheck(window.isSecureContext && navigator.requestMIDIAccess && navigator.locks,
    'Use desktop Chrome or Edge over HTTPS or localhost with USB MIDI available.');
  // Both firmwares share the GitHub Pages origin, editor bus and device lock.
  await new Promise((resolve, reject) => {
    navigator.locks.request('rhythmer-device-operation', { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('Another installer is connected. Disconnect it first.')); return; }
      await new Promise(release => { releaseLock = release; resolve(); });
    }).catch(reject);
  });
  try {
    channel = new BroadcastChannel('jiant-midi');
    const announce = () => channel.postMessage({ type: 'installer', busy: true });
    announce();
    heartbeat = setInterval(announce, 4000);
    const midi = async () => (access = await navigator.requestMIDIAccess({ sysex: true }));
    up = new ReviewedUpdater(await midi(), log, { refresh: midi });
    source = await identify();inspectedDevice=deviceSummary(source);
    if(source.id==='FM-1_016'&&recovery?.product!=='FM-1_016'){el('stock-version').value='FM-1_016';el('recovery-selection').textContent='Official V16 detected. Select the original V16 FM-1.fwsc before continuing. Do not downgrade to V15.';}
    el('device-status').textContent = source.id + (source.name ? ' / ' + source.name : '');
    el('backup-label').textContent = source.name ? backupLabel :
      'This stock firmware or loader cannot export a musical archive here. I kept any earlier backups and original Break audio, and understand that data may be lost.';
    el('backup-status').textContent = source.name ? 'Ready to prepare a musical backup.' : 'Official firmware and the update loader do not offer a musical archive here.';
    status('Device identified. No device write has started.');
  } catch (e) {
    disconnect();
    throw e;
  }
}
async function backUp() {
  clearArchive();
  requireCheck(same(source, await identify()), 'The device changed. Disconnect and inspect it again.');
  const link = new BackupConnection(source.input, source.output);
  try {
    const file = await captureBackup((request, options) => link.request(request, options), source.name, (done, total) => {
      el('backup-status').textContent = 'Reading musical archive: ' + done.toLocaleString() + ' / ' + total.toLocaleString() + ' bytes.';
      if (progress.model.status === 'running') progress.bytes('backup', done, total, 'Reading and CRC-checking the musical archive.');
    }, { complete: true });
    requireCheck(file.objects.length > 0, 'The musical backup was empty.');
    archiveURL = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
    const linkToSave = el('backup-download');
    linkToSave.href = archiveURL;
    linkToSave.download = source.id + '-before-' + mode + '-musical-backup.json';
    linkToSave.hidden = false;
    el('backup-status').textContent = file.objects.length + ' objects verified. Download the archive before writing.';
  } finally { link.close(); }
}

const readyToWrite = () => checks.every(id => el(id).checked);
for (const id of checks) el(id).addEventListener('change', () => { el('confirm-write').disabled = !readyToWrite(); });
dialog.querySelector('form').addEventListener('submit', event => {
  if (event.submitter?.value === 'write' && !readyToWrite()) event.preventDefault();
});
async function review() {
  recoveryPolicy(source,recovery,mode);requireCheck(el('stock-version').value===recovery.product,'Select the verified original V16 file before continuing.');
  requireConsent();
  if(source.name){requireCheck(archiveURL,'A verified backup is required.');downloadBackup(el('backup-download'));}
  progress.enter('review','Initial consent accepted. Device, package and available backup checked.');
  return true;
}
function onStep(stage, value, detail) {
  const stages = {
    start: ['stage', 'Preparing the update loader.'],
    verify: ['stage', 'Serving update loader requests.'],
    loader: ['loader', 'Waiting for the loader USB MIDI port.'],
    'write-start': ['write', 'The loader is ready to request the package.'],
    write: ['write', 'Supplying package data to the update loader.'],
    reboot: ['reboot', 'Waiting for the FM-1 to restart.'],
    done: ['identity', 'The FM-1 has returned. Checking the installed package.']
  };
  const [id, message] = stages[stage];
  if (detail) progress.packet(id, detail, value);
  else progress.enter(id, message);
  el('result').textContent = message;
  if (lastStage !== stage) log(message);
  lastStage = stage;
}
async function transfer() {
  const checked = await identify();
  requireCheck(same(source, checked), 'The device changed after review. Reconnect and back up again.');
  recoveryPolicy(source,recovery,mode);const reviewed = target;
  const verified = mode === 'stock' ? recovery : await checkedPackage(manifest.jazzy, 'jazzy');
  requireCheck(verified.sha256 === reviewed.sha256, 'The target package changed after review.');
  progress.configure({ mode, resume: source.resume });
  progress.enter(source.resume ? 'loader' : 'stage', 'Preparing the reviewed package for transfer.');
  lastStage = undefined;
  localStorage.setItem(checkpointKey, reviewed.sha256);
  up.expected = source;
  writing = true;
  try {
    if (source.resume) requireCheck(await up.resume(verified.image, onStep, reviewed.product), 'The transfer did not complete.');
    else await up.install(verified.image, reviewed.product, onStep);

    progress.enter('final', 'Verifying the restarted FM-1.');
    if (mode === 'jazzy') {
      const ports = up.installedPorts;
      requireCheck(ports, 'The FM-1 did not reconnect after transfer.');
      const link = new BackupConnection(ports.input, ports.output);
      try {
        const reply = await link.request([80, []], { timeout: 8000, retries: 2 });
        requireCheck(reply.join(',') === '83,73,88,51,0,3', 'JAZZY restarted, but both Break banks could not be verified.');
      } finally { link.close(); }
    }
    localStorage.removeItem(checkpointKey);
    const done = mode === 'stock' ? stockName(target.product)+' verified as '+target.product+'.' : 'JAZZY verified after restart. Break A and B are readable.';
    progress.finish(done);
    status(done);
  } finally {
    disconnect();
  }
}
function start() {
  try{requireConsent();}catch(e){status(e.message);el('start-consent').scrollIntoView();return;}
  return run(async () => {
    requireCheck(target && recovery, 'Wait for package verification.');
    progress.begin({ mode, resume: source?.resume });
    progress.enter('device', 'Checking the connected FM-1.');
    if (!source) await connect();
    progress.configure({ mode, resume: source.resume });
    if (source.name && !archiveURL) {
      progress.enter('backup', 'Reading the complete musical archive.');
      await backUp();
    } else if (!source.name) progress.model.skip('backup');
    if (!await review()) {
      progress.cancel();
      status('Review cancelled. No device write has started.');
      return;
    }
    await transfer();
  });
}

el('start').onclick = el('review').onclick = start;
el('connect').onclick = () => run(connect);
el('disconnect').onclick = () => { disconnect(); status('Disconnected.'); refresh(); };
el('backup').onclick = () => run(backUp);
el('stock-version').onchange=()=>run(async()=>{officialOverride=null;if(el('stock-version').value==='FM-1_015'){await preload();el('recovery-selection').textContent='V15 selected and verified.';}else{el('stock-status').textContent='Select the unmodified official V16 FM-1.fwsc below.';el('recovery-selection').textContent='V16 selected. Final review waits for its verified original file.';}});
el('stock-file').onchange=()=>run(async()=>{const file=el('stock-file').files[0];if(!file)return;officialOverride=null;recovery=null;if(mode==='stock')target=null;const candidate=await validateOfficial(new Uint8Array(await file.arrayBuffer()));officialOverride=candidate;recovery=candidate;el('stock-version').value=candidate.product;if(mode==='stock'){target=candidate;el('build-status').textContent='READY / Recovery target: '+stockName(candidate.product)+' ('+candidate.product+'). SHA-256: '+candidate.sha256;}el('stock-status').textContent='READY / '+stockName(candidate.product)+': exact size, package and SHA-256 verified.';el('recovery-selection').textContent=stockName(candidate.product)+' selected. No device write has started.';});
el('report').addEventListener('click', event => {
  if (reportURL) URL.revokeObjectURL(reportURL);
  reportURL = URL.createObjectURL(new Blob([JSON.stringify({
    installerRevision:INSTALLER_REVISION,environment:environment(),source:inspectedDevice,recovery:recovery&&{product:recovery.product,sha256:recovery.sha256},error:lastError,mode, target: target && { product: target.product, sha256: target.sha256 },
    progress: progress.model.snapshot(), events
  }, null, 2)], { type: 'application/json' }));
  event.currentTarget.href = reportURL;
});
window.addEventListener('beforeunload', event => {
  if (writing) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { if (!writing) disconnect(); });

if (mode === 'stock') {
  document.title = 'JAZZY / Official V15 / V16 Recovery';
  el('title').textContent = 'OFFICIAL RECOVERY.';
  el('intro').textContent = 'Select official V15 or V16 to match the original boot version. V15 is included; V16 requires the original file.';
  el('start-label').textContent = 'OFFICIAL V15 / V16 RECOVERY';
  el('start-title').textContent = 'Your stock firmware, ready.';
  el('start-description').textContent = 'The official V15 file is included and verified automatically. Back up your custom music before restoring stock firmware.';
  el('start').textContent = 'RESTORE SELECTED OFFICIAL FIRMWARE →';
  el('review').textContent = 'REVIEW OFFICIAL RECOVERY →';
  el('review-heading').textContent = 'Restore the original firmware.';
  el('review-copy').textContent = 'Official V15 recovery installs stock firmware and verifies its identity after restart. Custom music is not imported into V15.';
  for (const id of ['sample-brief', 'bundle-download', 'v15-recommendation', 'confirm-v15-row', 'confirm-audio-row']) el(id).hidden = true;
}
progress.render(true);
run(async () => {
  try { await preload(); }
  catch (e) { el('build-status').textContent = 'Package verification stopped: ' + e.message; throw e; }
});

document.addEventListener('visibilitychange',()=>{if(writing&&document.hidden)log('Installer tab hidden: background throttling can delay USB MIDI replies. Keep this page visible, the computer awake and USB/power connected.');});

document.querySelectorAll('[data-start-check]').forEach(x=>x.addEventListener('change',refresh));
