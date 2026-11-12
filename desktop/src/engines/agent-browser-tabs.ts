export interface NativeTab {
  tabId?: string;
  targetId?: string;
  label?: string | null;
  active?: boolean;
}

export function parseNativeTabs(stdout: string): NativeTab[] {
  const parsed = JSON.parse(stdout) as { data?: { tabs?: NativeTab[] | null } };
  return parsed.data?.tabs ?? [];
}

export function activeNativeTab(tabs: readonly NativeTab[]): { targetId: string } | undefined {
  const active = tabs.find((tab) => tab.active);
  return active?.targetId ? { targetId: active.targetId } : undefined;
}
