@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
set "guardFixtureOut=%~dp0..\..\build\native-guard-test"
if not exist "%guardFixtureOut%" mkdir "%guardFixtureOut%"
pushd "%guardFixtureOut%"
cl /nologo /O2 /LD /MT /Fe:jvm.dll /Fo:module.obj "%~dp0module.cpp" /link /DYNAMICBASE /NXCOMPAT
if errorlevel 1 exit /b 1
cl /nologo /O2 /EHsc /MT /Fe:java.exe /Fo:fixture.obj "%~dp0fixture.cpp" /link /DYNAMICBASE /NXCOMPAT
if errorlevel 1 exit /b 1
popd
