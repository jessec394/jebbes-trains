import os, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

from devtools.__main__ import main as cli, missing_packages

def main():
    need = missing_packages()
    if need:
        print(f"Installing {', '.join(need)} ...")
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', *need])

    from devtools import config
    if not os.path.exists(config.GRAPH_DB):
        cli(['setup'])

    cli(['serve', '--open'])

if __name__ == '__main__': main()