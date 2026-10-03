import subprocess
import sys
import os

def Run(Cmd, Check=True, Capture=False):
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

def Confirm(Prompt):
    Answer = input(f"{Prompt} [yes/N]: ").strip().lower()
    if Answer != "yes":
        print("Aborted.")
        sys.exit(0)

def Main():
    RepoResult = Run("git rev-parse --show-toplevel", Capture=True, Check=False)
    if RepoResult.returncode != 0:
        print("Not inside a git repository.")
        sys.exit(1)

    RepoRoot = RepoResult.stdout.strip()
    os.chdir(RepoRoot)
    print(f"Repository root: {RepoRoot}")

    RemoteResult = Run("git remote", Capture=True, Check=False)
    RemoteList = RemoteResult.stdout.strip().splitlines()
    HasRemote = bool(RemoteList)
    RemoteName = RemoteList[0] if HasRemote else None

    if HasRemote:
        print(f"Remote detected: {RemoteName}")
        print("Fetching from remote...")
        Run(f"git fetch {RemoteName}", Check=False)
    else:
        print("No remote detected — will only rewrite local history.")

    Dirty = Run("git status --porcelain", Capture=True).stdout.strip()
    if Dirty:
        print("\nYou have uncommitted changes:")
        print(Dirty)
        Confirm("\nThese will be included in the squashed commit. Continue?")

    Branch = Run("git rev-parse --abbrev-ref HEAD", Capture=True).stdout.strip()
    print(f"Current branch: {Branch}")

    print("\n" + "=" * 60)
    print("  WARNING: DESTRUCTIVE OPERATION")
    print("=" * 60)
    print("This script will:")
    print("  1. Commit any uncommitted changes (if present)")
    print("  2. Replace ALL git history with a single 'Initial commit'")
    print("  3. Delete all branches except the current one")
    if HasRemote:
        print(f"  4. Force-push to '{RemoteName}/{Branch}'")
    print("\nThis CANNOT be undone. All previous commits will be lost.")
    Confirm("\nType 'yes' to proceed")

    if Dirty:
        print("\nStaging uncommitted changes...")
        Run("git add -A")
        Run('git commit -m "wip: save state before squash"')
        print("   Changes committed.")

    print("\nSquashing history...")

    Run(f"git checkout --orphan _squash_temp")
    Run("git add -A")
    Run('git commit -m "Initial commit"')

    Run(f"git branch -D {Branch}")
    Run(f"git branch -m {Branch}")

    print(f"   History squashed into a single 'Initial commit' on '{Branch}'.")

    AllBranches = Run("git branch", Capture=True).stdout.strip().splitlines()
    OtherBranches = [
        B.strip().lstrip("* ") for B in AllBranches
        if B.strip().lstrip("* ") not in (Branch, "_squash_temp")
    ]

    if OtherBranches:
        print(f"\nDeleting {len(OtherBranches)} other local branch(es)...")
        for B in OtherBranches:
            Run(f"git branch -D {B}", Check=False)
            print(f"   Deleted: {B}")

    if HasRemote:
        print(f"\nForce-pushing to {RemoteName}/{Branch}...")
        PushResult = Run(
            f"git push {RemoteName} {Branch} --force --prune",
            Capture=True, Check=False
        )
        if PushResult.returncode != 0:
            print(f"Push failed:\n{PushResult.stderr.strip()}")
            print(f"\nYou can try manually: git push {RemoteName} {Branch} --force --prune")
            sys.exit(1)
        print("   Force-push successful.")

        print("\nFetching from remote after push...")
        Run(f"git fetch {RemoteName}", Check=False)

    print("\nDone. Git history has been squashed.")
    Log = Run("git log --oneline", Capture=True).stdout.strip()
    print(f"\nCurrent log:\n   {Log}")


if __name__ == "__main__":
    Main()