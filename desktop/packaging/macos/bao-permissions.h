#ifndef BAO_PERMISSIONS_H
#define BAO_PERMISSIONS_H

/* seam: 0 real, 1 forced denied, 2 forced allowed.
 * dock: 0 none, 1 Accessibility pane, 2 Files & Folders pane.
 * appearance: 0 system, 1 light, 2 dark. */
typedef struct {
  int check;
  int seam;
  int dock;
  int appearance;
  const char *shot;
} BaoPermissionsOpts;

int bao_permissions_show(const BaoPermissionsOpts *opts);

#endif
