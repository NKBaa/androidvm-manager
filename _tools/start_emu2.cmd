@echo off
set ANDROID_HOME=C:\Users\www34\Desktop\Ä£ÄâÆ÷\android-sdk
set ANDROID_SDK_ROOT=%ANDROID_HOME%
set ANDROID_USER_HOME=C:\Users\www34\Desktop\Ä£ÄâÆ÷\home\.android
set ANDROID_AVD_HOME=C:\Users\www34\Desktop\Ä£ÄâÆ÷\avd
set ADB_VENDOR_KEYS=C:\Users\www34\Desktop\Ä£ÄâÆ÷\home\.android
set TEMP=C:\Users\www34\Desktop\Ä£ÄâÆ÷\home\adbhome
set TMP=%TEMP%
cd /d "C:\Users\www34\Desktop\Ä£ÄâÆ÷"
"%ANDROID_HOME%\emulator\emulator.exe" -avd A14_Root -port 5554 -no-metrics -no-boot-anim -writable-system -gpu swiftshader_indirect -no-audio > "C:\Users\www34\Desktop\Ä£ÄâÆ÷\_logs\em5.log" 2>&1
