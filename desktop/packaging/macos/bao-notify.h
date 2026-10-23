#ifndef BAO_NOTIFY_H
#define BAO_NOTIFY_H

/* Listen on sock_path before the Node child starts. The child inherits BAO_NOTIFY_SOCK. */
int bao_notify_prepare(const char *sock_path);

/* Main thread. Runs until the product browser exits, then stops Node.
 * Posts "You need to act" with UNUserNotificationCenter for this Bao.app. */
int bao_notify_run(int browser_pid, int node_pid);

/* Native alert. Used when Finder launched the app and stderr is invisible. */
void bao_show_alert(const char *title, const char *body);

/* Bring the existing product window forward. pid is the bundled browser. */
void bao_focus_pid(int pid);

#endif
