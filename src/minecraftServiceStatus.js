export const MINECRAFT_SERVICE_UNAVAILABLE_MESSAGE = 'Minecraft services or the Minecraft Launcher runtime are currently unavailable. Wait for Mojang/Microsoft services to recover, reopen Minecraft Launcher, then try AHT Launcher again.';

export function minecraftServiceFailureMessage(error = null) {
  const text = `${error?.message || error || ''}`;
  const compact = text.replace(/\s+/g, ' ');
  const certificatePattern = /PKIX|certification path|unable to find valid certification path|Failed to validate certificates/i;
  if (certificatePattern.test(compact)) {
    return '';
  }
  const explicitServicePattern = /REQUEST_FAILED|Unable to prepare assets for download/i;
  const serviceHostPattern = /launcher\.mojang\.com|launchermeta\.mojang\.com|piston-meta\.mojang\.com|resources\.download\.minecraft\.net|libraries\.minecraft\.net|api\.minecraftservices\.com|sessionserver\.mojang\.com|authserver\.mojang\.com|maven\.minecraftforge\.net|maven\.forgecdn\.net/i;
  const serviceNetworkPattern = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network timeout|ConnectException|UnknownHostException|SocketTimeoutException|Unexpected end of JSON input/i;
  const launcherRuntimePattern = /(?:could not open|ENOENT|no such file or directory|open).*?(?:java-runtime-[a-z0-9-]+|jre-legacy|[\\/]runtime[\\/].*(?:java-runtime|jre|jdk)|Microsoft\.4297127D64EC6_8wekyb3d8bbwe).*?(?:javaw?|jvm)\.cfg/i;
  const assetRepairPattern = /Minecraft (?:asset|library|client jar|logging config|runtime file) .*did not match Mojang metadata|Mojang metadata after download|Unable to prepare assets for download/i;
  const strippedMinecraftJsonPattern = /^SyntaxError:\s*Unexpected end of JSON input$|^Unexpected end of JSON input$/i;
  if (!explicitServicePattern.test(compact)
    && !launcherRuntimePattern.test(compact)
    && !assetRepairPattern.test(compact)
    && !strippedMinecraftJsonPattern.test(compact)
    && !(serviceHostPattern.test(compact) && serviceNetworkPattern.test(compact))) {
    return '';
  }
  return MINECRAFT_SERVICE_UNAVAILABLE_MESSAGE;
}
