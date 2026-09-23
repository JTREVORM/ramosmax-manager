# ---------------------------------------------------------------------------
# RamosMAX Automotive Care — R8 / ProGuard configuration
# ---------------------------------------------------------------------------
# Flutter's own rules are contributed by the Flutter Gradle plugin; the entries
# below cover the Firebase SDKs and the reflection-sensitive paths we rely on.

# Firebase / Google Play services keep their own consumer rules, but Crashlytics
# needs line numbers and source file names to symbolicate release stack traces.
-keepattributes SourceFile,LineNumberTable
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes Exceptions

# Do not strip the custom exception types we report to Crashlytics, otherwise
# non-fatal reports collapse into unreadable obfuscated names.
-keep public class * extends java.lang.Exception

# Firestore models are serialised from Dart maps, not Java reflection, so no
# model keep-rules are required. Keep the Firebase entry points regardless.
-keep class com.google.firebase.** { *; }
-dontwarn com.google.firebase.**

# Play Core is referenced by Flutter's deferred-components support even when the
# app does not use deferred components.
-dontwarn com.google.android.play.core.**
