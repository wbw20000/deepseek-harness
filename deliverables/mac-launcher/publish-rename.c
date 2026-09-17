// Build-only publication helper for deliverables/mac-launcher/build.sh. The
// build compiles it with the host's Command Line Tools into the private
// staging directory and never ships the binary inside the bundle.
//
// The helper performs the one operation publication needs: an atomic
// no-replace rename of the staged bundle to its destination. renamex_np with
// RENAME_EXCL either moves the source to a destination that does not exist or
// changes nothing, so a concurrent writer that creates the destination first
// makes the helper fail while the winner stays untouched. No fallback CLI is
// involved: mv -n moves its source inside an existing destination directory
// instead of leaving it in place, which is not a no-replace publication.
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stdio.h>

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: publish-rename <staged path> <destination path>\n");
        return 2;
    }
    if (renamex_np(argv[1], argv[2], RENAME_EXCL) != 0) {
        fprintf(stderr, "publish-rename: could not atomically publish %s as %s: %s\n",
                argv[1], argv[2], strerror(errno));
        return 1;
    }
    return 0;
}
