import os
import subprocess
import sys

MaxFileBytes = 90 * 1024 * 1024
TempBranch = "_squash_temp"

def run(Cmd, Check=True, Capture=False):
    Result = subprocess.run(
        Cmd, shell=True, text=True,
        stdout=subprocess.PIPE if Capture else None,
        stderr=subprocess.PIPE if Capture else None
    )
    if Check and Result.returncode != 0:
        Err = Result.stderr.strip() if Capture else ""
        print(f"Command failed: {Cmd}")
        if Err:
            print(f"   {Err}")
        sys.exit(1)
    return Result


def confirm(Prompt):
    Answer = input(f"{Prompt} [yes/N]: ").strip().lower()
    if Answer != "yes":
        print("Aborted.")
        sys.exit(0)


def main():
    RepoResult = run("git rev-parse --show-toplevel", Capture=True, Check=False)
    if RepoResult.returncode != 0:
        print("Not inside a git repository.")
        sys.exit(1)

    RepoRoot = RepoResult.stdout.strip()
    os.chdir(RepoRoot)
    print(f"Repository root: {RepoRoot}")

    RemoteList = run("git remote", Capture=True, Check=False).stdout.strip().splitlines()
    HasRemote = bool(RemoteList)
    RemoteName = RemoteList[0] if HasRemote else None
    if HasRemote:
        print(f"Remote detected: {RemoteName}")
    else:
        print("No remote detected - will only rewrite local history.")

    Branch = run("git rev-parse --abbrev-ref HEAD", Capture=True).stdout.strip()
    if Branch == "HEAD":
        print("You are on a detached HEAD. Check out a branch first.")
        sys.exit(1)
    print(f"Current branch: {Branch}")

    Dirty = run("git status --porcelain", Capture=True).stdout.strip()
    if Dirty:
        print("\nUncommitted / untracked changes (they will be INCLUDED as they are on disk):")
        print(Dirty)

    print("\n" + "=" * 60)
    print("  WARNING: DESTRUCTIVE OPERATION")
    print("=" * 60)
    print("This script will:")
    print("  1. Take every file as it is on disk now (respecting .gitignore)")
    print("  2. Replace ALL git history with a single 'Initial commit'")
    print("  3. Delete all other local branches and tags")
    print("  4. Permanently delete the old commits from this clone (reflog + gc)")
    if HasRemote:
        print(f"  5. Force-push to '{RemoteName}/{Branch}'")
    print("\nThis CANNOT be undone. All previous commits will be lost.")
    confirm("\nType 'yes' to proceed")

    # leftover from an earlier failed run
    run(f"git branch -D {TempBranch}", Check=False, Capture=True)

    print("\nSquashing history...")
    run(f"git checkout --orphan {TempBranch}")
    # An orphan branch starts with the OLD branch's index. Empty it, so that files that were committed before but are now
    # ignored (e.g. devtools/cache) are not carried into the new commit; then stage the working tree from scratch.
    run("git rm -r -f --cached -q .", Check=False, Capture=True)
    run("git add -A")

    Staged = run("git ls-files -z", Capture=True).stdout.split("\0")
    Big = []
    for Name in Staged:
        if Name and os.path.isfile(Name) and os.path.getsize(Name) > MaxFileBytes:
            Big.append((os.path.getsize(Name), Name))
    if Big:
        print("\nThese files are over 90 MB and would break the push. Nothing was committed or deleted:")
        for Size, Name in sorted(Big, reverse=True):
            print(f"   {Size / 1024 / 1024:8.0f} MB  {Name}")
        print("Add them to .gitignore (or delete them), then run this script again.")
        run(f"git reset -q", Check=False, Capture=True)
        run(f"git checkout -q -f {Branch}", Check=False, Capture=True)
        run(f"git branch -D {TempBranch}", Check=False, Capture=True)
        sys.exit(1)

    print(f"   {len([N for N in Staged if N])} files staged.")
    run('git commit -q -m "Initial commit"')

    run(f"git branch -D {Branch}")
    run(f"git branch -m {Branch}")
    print(f"   History squashed into a single 'Initial commit' on '{Branch}'.")

    Others = [
        B.strip().lstrip("* ").strip()
        for B in run("git branch", Capture=True).stdout.splitlines()
    ]
    Others = [B for B in Others if B and B != Branch]
    for B in Others:
        run(f"git branch -D {B}", Check=False, Capture=True)
        print(f"   Deleted branch: {B}")
    for Tag in run("git tag", Capture=True).stdout.split():
        run(f"git tag -d {Tag}", Check=False, Capture=True)
        print(f"   Deleted tag: {Tag}")

    print("\nRemoving the old commits from this clone (frees the disk space)...")
    run("git reflog expire --expire=now --all", Check=False)
    run("git gc --prune=now --aggressive", Check=False, Capture=True)

    if HasRemote:
        print(f"\nForce-pushing to {RemoteName}/{Branch}...")
        Push = run(f"git push {RemoteName} {Branch} --force", Capture=True, Check=False)
        if Push.returncode != 0:
            print(f"Push failed:\n{Push.stderr.strip()}")
            print(f"\nYou can try manually: git push {RemoteName} {Branch} --force")
            sys.exit(1)
        print("   Force-push successful.")
        run(f"git branch --set-upstream-to={RemoteName}/{Branch} {Branch}", Check=False, Capture=True)

    print("\nDone. Git history has been squashed.")
    print(f"\nCurrent log:\n   {run('git log --oneline', Capture=True).stdout.strip()}")


if __name__ == "__main__":
    main()