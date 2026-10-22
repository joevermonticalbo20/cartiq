/// The app version shown in the UI.
///
/// Single source of truth on purpose. pubspec.yaml carries `version: 1.0.1+3`
/// (the `+3` is the Android versionCode), but Dart cannot read pubspec at
/// runtime without a plugin, so the same number is kept here by hand.
///
/// Bump BOTH on every release: the version in pubspec.yaml and the constant
/// below. They used to disagree - pubspec said 1.0.0+1, the built APK said
/// 1.0.0+2, and the UI said v1.0.0 - three different numbers for one app.
library;

const String appVersion = '1.0.1';
