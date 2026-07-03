import { minecraftServiceFailureMessage } from '../src/minecraftServiceStatus.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const serviceMessage = minecraftServiceFailureMessage(new SyntaxError('Unexpected end of JSON input'));
assert(serviceMessage.includes('Minecraft services'), `Bare Play JSON parse failure was not classified as service downtime: ${serviceMessage}`);
assert(!serviceMessage.includes('Unexpected end of JSON'), 'Friendly service message leaked the raw JSON parse failure.');

const mojangHostMessage = minecraftServiceFailureMessage('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json SyntaxError: Unexpected end of JSON input');
assert(mojangHostMessage.includes('Mojang/Microsoft'), `Mojang metadata parse failure was not classified as service downtime: ${mojangHostMessage}`);

const launcherMetaHostMessage = minecraftServiceFailureMessage('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json SyntaxError: Unexpected end of JSON input');
assert(launcherMetaHostMessage.includes('Mojang/Microsoft'), `Minecraft launcher metadata parse failure was not classified as service downtime: ${launcherMetaHostMessage}`);

const requestFailedMessage = minecraftServiceFailureMessage('Internal error. Name: REQUEST_FAILED Error details: Unable to prepare assets for download');
assert(requestFailedMessage.includes('Minecraft services'), `Minecraft Launcher asset failure was not classified as service downtime: ${requestFailedMessage}`);

const runtimeMessage = minecraftServiceFailureMessage("Forge installer exited with code 1: Error: could not open 'C:\\Users\\Player\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime\\java-runtime-gamma\\windows-x64\\java-runtime-gamma\\bin\\javaw.exe\\lib\\amd64\\jvm.cfg'");
assert(runtimeMessage.includes('Minecraft services'), `Minecraft Launcher runtime outage was not classified as service downtime: ${runtimeMessage}`);
assert(!runtimeMessage.includes('jvm.cfg') && !runtimeMessage.includes('javaw.exe'), 'Friendly runtime outage message leaked low-level launcher runtime paths.');

const runtimeEnoentMessage = minecraftServiceFailureMessage("ENOENT: no such file or directory, open 'C:\\Users\\Player\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime\\java-runtime-gamma\\windows-x64\\java-runtime-gamma\\lib\\amd64\\jvm.cfg'");
assert(runtimeEnoentMessage.includes('Minecraft services'), `Minecraft Launcher runtime ENOENT was not classified as service downtime: ${runtimeEnoentMessage}`);
assert(!runtimeEnoentMessage.includes('jvm.cfg') && !runtimeEnoentMessage.includes('ENOENT'), 'Friendly runtime ENOENT message leaked low-level launcher runtime paths.');

const assetHashMessage = minecraftServiceFailureMessage('Minecraft asset minecraft/sounds/music/game/calm1.ogg from https://resources.download.minecraft.net/ab/abcdef did not match Mojang metadata after download.');
assert(assetHashMessage.includes('Minecraft services'), `Minecraft asset hash mismatch was not classified as service downtime: ${assetHashMessage}`);
assert(!assetHashMessage.includes('calm1.ogg') && !assetHashMessage.includes('Mojang metadata after download'), 'Friendly asset hash message leaked low-level asset validation details.');

const certificateMessage = minecraftServiceFailureMessage('PKIX path building failed while connecting to https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar');
assert(certificateMessage === '', `Certificate failures must stay Java setup errors, not service downtime: ${certificateMessage}`);

const localJsonMessage = minecraftServiceFailureMessage('Installed manifest is damaged. Unexpected end of JSON input');
assert(localJsonMessage === '', `Local manifest corruption must not be mislabeled as Minecraft service downtime: ${localJsonMessage}`);

console.log('minecraft service status tests passed');
