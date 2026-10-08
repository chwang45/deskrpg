/** The personal-DB secretary. One private room, orders from the head only. */

export const PRIVATE_SECRETARY_PROFILE = "private-secretary";
export const PRIVATE_SECRETARY_CHANNEL = "PrivateSecretary";
export const SECRET_CHANNEL_MARK = "secret-secretary";

export function isPrivateSecretaryProfile(profileName: string | null | undefined): boolean {
  return profileName === PRIVATE_SECRETARY_PROFILE;
}

export function isSecretChannel(channel: {
  name?: string | null;
  description?: string | null;
}): boolean {
  return (
    channel.name === PRIVATE_SECRETARY_CHANNEL ||
    (channel.description ?? "").startsWith(SECRET_CHANNEL_MARK)
  );
}

/**
 * Doors and the Settings jump list. The private room opens only from Office.
 * Other offices do not list it. The private room opens only back to Office.
 */
export function officeDoorTargets<T extends { id: string; name: string; secret?: boolean }>(
  currentName: string,
  currentId: string,
  channels: readonly T[],
): T[] {
  const others = channels.filter((item) => item.id !== currentId);
  if (currentName === PRIVATE_SECRETARY_CHANNEL) {
    return others.filter((item) => item.name === "Office");
  }
  if (currentName === "Office") return others;
  return others.filter((item) => item.name !== PRIVATE_SECRETARY_CHANNEL && !item.secret);
}
