# ML Kit text recognition references optional language-pack classes
# (Chinese, Devanagari, Japanese, Korean) that are not bundled.
# The app only uses the Latin recognizer, so silence those warnings
# (rules suggested by R8 in build/app/outputs/mapping/release/missing_rules.txt).
-dontwarn com.google.mlkit.vision.text.chinese.**
-dontwarn com.google.mlkit.vision.text.devanagari.**
-dontwarn com.google.mlkit.vision.text.japanese.**
-dontwarn com.google.mlkit.vision.text.korean.**
# MlKitInitProvider wires these through internal DI at app startup;
# shrinking or renaming any of them crashes every launch with
# "Unsatisfied dependency", so keep the whole ML Kit trees.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
-keep class com.google_mlkit_text_recognition.** { *; }
-dontwarn com.google.mlkit.**
-dontwarn com.google.android.gms.internal.mlkit_**
