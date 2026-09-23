import 'package:flutter/material.dart';

/// Single source of truth for RamosMAX company identity.
///
/// Screens, receipts, invoices and reports read company details from here —
/// never hard-code the company name, logo path or contact details elsewhere.
abstract final class Brand {
  static const String companyName = 'RamosMAX Automotive Care';
  static const String legalName = 'RamosMAX Automotive Care (U) Ltd';
  static const String shortName = 'RamosMAX';
  static const String tagline = 'Automotive Care';
  static const String systemName = 'RamosMAX Management System';

  // Contact details appear on future receipts, invoices and reports.
  // TODO(business): replace with the verified company contact details before
  // the first production release. Left empty rather than invented.
  static const String phone = '0748020649';
  static const String email = 'ramosmaxautomotivecare@gmail.com';
  static const String address = 'bukoto kisasi road Kampala, Uganda';
  static const String website = 'https://ramosmaxauto.com';
  static const String tin = '';

  /// Operating country, used for phone defaults and currency.
  static const String countryCode = 'UG';

  // --- Assets --------------------------------------------------------------
  // `logo` is the official artwork exactly as supplied (brand purple
  // background). `logoOnDark` has the purple background removed; it must only
  // be placed on the brand purple or a darker surface because its anti-aliased
  // edges carry the original background tint.
  static const String logo = 'assets/branding/ramosmax_logo.png';
  static const String logoOnDark =
      'assets/branding/ramosmax_logo_transparent.png';
  static const String appIcon = 'assets/branding/app_icon_1024.png';

  // --- Colours sampled from the official logo ------------------------------
  static const Color purple = Color(0xFF362060);
  static const Color purpleDeep = Color(0xFF24133F);
  static const Color gold = Color(0xFFD0AD47);
  static const Color goldDeep = Color(0xFFA8872B);
}
