import sys, os

Directory = os.path.abspath(os.path.dirname(__file__))

sys.path.insert(0, os.path.join(Directory, 'Input'))
sys.path.insert(0, os.path.join(Directory, 'Modules'))

from Modules.MapBuilder import MapBuilder

InputFolder = os.path.join(Directory, 'Input')
LinesPath = os.path.join(InputFolder, 'Lines')
SavePath = os.path.join(Directory, 'index.html')

Builder = MapBuilder(LinesPath)

Builder.BuildMap()
Builder.Save(SavePath)