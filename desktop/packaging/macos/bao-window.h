#ifndef BAO_WINDOW_H
#define BAO_WINDOW_H

/* Main thread. Owns the native product window and stops Node when Bao quits. */
int bao_window_run(const char *url, int node_pid);

#endif
