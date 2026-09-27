"""Session set-up for the server tests."""
from fvwks_server.service import bind_native_exit_hooks

# Collection runs on the main thread before any test does. Bind MLX's exit hook to it now, even in a combined run
# where another package's tests would first use MLX on a worker thread (see bind_native_exit_hooks).
bind_native_exit_hooks()
