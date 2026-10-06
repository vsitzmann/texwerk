/**
 * Whether deleting `count` of a project's `total` files at once is a mass
 * deletion that a mirror must never send on its own.
 *
 * A mirror sees a folder emptied by `rm -rf`, a wiped checkout, or a disk
 * that went away exactly as it sees a user deleting files, one path at a
 * time. Deleting a file or a folder of figures is normal; deleting the whole
 * project, or most of it, from a mirror is almost always an accident, and it
 * is the one change that would empty everyone's project. Such deletions are
 * refused (the bridge restores the files locally, the server answers 409);
 * people can still delete anything in the browser.
 */
export function isMassDeletion(count: number, total: number): boolean {
  if (count <= 0) return false;
  return count >= total || (count >= MASS_DELETION_MIN && count * 2 > total);
}

/** Below this many files, deleting most of a (tiny) project is still allowed. */
export const MASS_DELETION_MIN = 3;

/**
 * Deletions from mirrors this close together count as one batch on the
 * server: a bridge from before the folder check sends a removed folder's files
 * within milliseconds of each other; separate deletes come further apart.
 */
export const MASS_DELETION_WINDOW_MS = 1000;
