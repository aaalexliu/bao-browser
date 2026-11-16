/* Test entry for bao-permissions.m. It shows the permission window with both grants forced
 * off, so no TCC check runs. mac-launch.test.ts starts it twice. */
#import "bao-permissions.m"

int main(void) {
  BaoPermissionsOpts opts = {0, 1, 0, 0, NULL};
  return bao_permissions_show(&opts);
}
