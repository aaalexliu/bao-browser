#ifndef BAO_NOTIFY_H
#define BAO_NOTIFY_H

/* Listen on sock_path before the Node child starts. The child inherits BAO_NOTIFY_SOCK. */
int bao_notify_prepare(const char *sock_path);

/* Main thread. Posts "You need to act" for this Bao.app without owning its window. */
void bao_notify_start(void);
void bao_notify_stop(void);

/* Native alert. Used when Finder launched the app and stderr is invisible. */
void bao_show_alert(const char *title, const char *body);

/* Reopen the existing Bao app and bring its native window forward. */
void bao_focus_pid(int pid);

#endif
