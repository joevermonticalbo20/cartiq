# ML Kit text recognition references optional language-pack classes
# (Chinese, Devanagari, Japanese, Korean) that are not bundled.
# The app only uses the Latin recognizer, so silence those warnings
# (rules suggested by R8 in build/app/outputs/mapping/release/missing_rules.txt).
-dontwarn com.google.mlkit.vision.text.chinese.**
-dontwarn com.google.mlkit.vision.text.devanagari.**
-dontwarn com.google.mlkit.vision.text.japanese.**
-dontwarn com.google.mlkit.vision.text.korean.**
# Keep the text APIs and the Flutter plugin bridge themselves.
-keep class com.google.mlkit.vision.text.** { *; }
-keep class com.google_mlkit_text_recognition.** { *; }
