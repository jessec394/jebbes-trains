import os

def GetTemplateContent():
    TemplatePath = os.path.join(os.path.dirname(__file__), 'Assets', 'Template.html')
    with open(TemplatePath, 'r', encoding='utf-8') as F:
        return F.read()

def GetStylesheet():
    StylePath = os.path.join(os.path.dirname(__file__), 'Assets', 'Styles.css')
    with open(StylePath, 'r', encoding='utf-8') as F:
        return f"<style>\n{F.read()}\n</style>"

def GetJavascriptLibrary():
    JsPath = os.path.join(os.path.dirname(__file__), 'Assets', 'Map.js')
    with open(JsPath, 'r', encoding='utf-8') as F:
        return f"<script>\n{F.read()}\n</script>"

SIDEBAR_HTML = GetStylesheet() + GetTemplateContent() + GetJavascriptLibrary()