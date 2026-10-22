#ifndef BAO_NOTIFY_H
#define BAO_NOTIFY_H

/* Listen on sock_path before the Node child starts. The child inherits BAO_NOTIFY_SOCK. */
int bao_notify_prepare(const char *sock_path);

/* Main thread. Runs until the product browser exits, then stops Node.
 * Posts "You need to act" with UNUserNotificationCenter for this Bao.app. */
int bao_notify_run(int browser_pid, int node_pid);

#endif
