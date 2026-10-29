/** Live Chrome needs Accessibility. Screen Recording does not block it. */
export function liveChromeBlock(perms: {
  prompted?: boolean;
  accessibility?: boolean;
  screenCapture?: boolean;
}): string | undefined {
  if (perms.prompted) return "helper asked for a permission prompt";
  if (perms.accessibility !== true) return "BaoOSHelper accessibility is not granted";
  return undefined;
}
