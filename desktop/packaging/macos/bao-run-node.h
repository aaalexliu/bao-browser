#ifndef BAO_RUN_NODE_H
#define BAO_RUN_NODE_H

/* Bao.app/Contents/MacOS/bao --run-node [--own] <cli.js> [args...]
 *
 * bao-mcp and bao-cli start Node through Bao.app's main executable. Before a
 * process reads another app's data, such as Google Chrome's folder, macOS asks
 * about the app responsible for it (System Settings > Privacy & Security >
 * Files & Folders). A process started by an agent app is that app's
 * responsibility, so Codex, Claude, or a terminal would need the switch.
 *
 * With --own, or in a build signed with a certificate (BAO_CERT_SIGNED), this
 * starts a copy of itself that answers for itself, so macOS asks about Bao.
 * An ad-hoc build leaves agents with their own app: macOS ties an ad-hoc
 * grant to one build, so a grant to Bao would not survive an update. When this
 * process answers for itself, it stays as Node's parent, because Node in its
 * place would answer as Node. Otherwise it becomes Node.
 *
 * Bao's grant covers only Bao's own code. The script must be this bundle's
 * Contents/Resources/bao/src/app/cli.js; anything else is refused. This
 * process picks Node itself with bao_pick_node, and a process that answers as
 * Bao ignores BAO_NODE. bao-main.c clears NODE_OPTIONS and NODE_PATH first.
 *
 * Node gets BAO_RESPONSIBLE_EXE, the executable of the app macOS asks, and
 * BAO_CERT_SIGNED=1 in a certificate build. */
int bao_run_node(const char *self, int argc, char *argv[]);

/* Sets BAO_RESPONSIBLE_EXE and BAO_CERT_SIGNED for this process's children,
 * as bao_run_node does for Node. Returns the pid macOS asks about. */
int bao_note_responsible(void);

#endif
