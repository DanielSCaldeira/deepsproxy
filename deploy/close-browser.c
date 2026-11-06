/* Ask only windows owned by the worker's browser PID to close normally.
 * WM_DELETE_WINDOW lets Chromium flush cookies before the process exits. */
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static Display *display;
static Atom pid_atom, protocols_atom, delete_atom;
static unsigned long browser_pid;
static unsigned int sent;
static int check_only;

static int ignore_gone_window(Display *d, XErrorEvent *event) {
  (void)d; (void)event;
  return 0;
}

static void request_close(Window window, unsigned int depth) {
  Atom type;
  int format;
  unsigned long count, remaining;
  unsigned char *data = NULL;
  if (XGetWindowProperty(display, window, pid_atom, 0, 1, False, XA_CARDINAL,
      &type, &format, &count, &remaining, &data) == Success && data &&
      type == XA_CARDINAL && format == 32 && count == 1 &&
      *(unsigned long *)data == browser_pid) {
    Atom *protocols = NULL;
    int n = 0;
    if (XGetWMProtocols(display, window, &protocols, &n)) {
      for (int i = 0; i < n; i++) {
        if (protocols[i] != delete_atom) continue;
        if (check_only) { sent++; break; }
        XEvent event;
        memset(&event, 0, sizeof(event));
        event.xclient.type = ClientMessage;
        event.xclient.window = window;
        event.xclient.message_type = protocols_atom;
        event.xclient.format = 32;
        event.xclient.data.l[0] = (long)delete_atom;
        event.xclient.data.l[1] = CurrentTime;
        if (XSendEvent(display, window, False, NoEventMask, &event)) sent++;
        break;
      }
      XFree(protocols);
    }
  }
  if (data) XFree(data);
  if (depth >= 32) return;
  Window root, parent, *children = NULL;
  unsigned int children_count;
  if (XQueryTree(display, window, &root, &parent, &children, &children_count)) {
    for (unsigned int i = 0; i < children_count; i++) request_close(children[i], depth + 1);
    if (children) XFree(children);
  }
}

int main(int argc, char **argv) {
  const char *pid_text;
  if (argc == 3 && strcmp(argv[1], "--check") == 0) {
    check_only = 1;
    pid_text = argv[2];
  } else if (argc == 2) {
    pid_text = argv[1];
  } else return 1;
  if (pid_text[0] < '0' || pid_text[0] > '9') return 1;
  char *end;
  errno = 0;
  browser_pid = strtoul(pid_text, &end, 10);
  if (errno || *end || !browser_pid || browser_pid > INT_MAX) return 1;
  display = XOpenDisplay(NULL);
  if (!display) return 2;
  XSetErrorHandler(ignore_gone_window);
  pid_atom = XInternAtom(display, "_NET_WM_PID", False);
  protocols_atom = XInternAtom(display, "WM_PROTOCOLS", False);
  delete_atom = XInternAtom(display, "WM_DELETE_WINDOW", False);
  request_close(DefaultRootWindow(display), 0);
  XSync(display, False);
  XCloseDisplay(display);
  return sent ? 0 : 3;
}
