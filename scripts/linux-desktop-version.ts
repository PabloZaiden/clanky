export function linuxDesktopUpdateVersion(version: string, build: string | undefined): string {
  if (!build || !/^[1-9]\d{0,7}$/.test(build)) {
    throw new Error("Linux desktop signing and publication require a positive CLANKY_LINUX_UPDATE_BUILD of at most eight digits.");
  }
  return `${version}+build.${build}`;
}
