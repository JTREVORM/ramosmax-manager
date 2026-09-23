import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/utils/validators.dart';
import '../../../models/customer.dart';
import '../application/operations_providers.dart';
import '../data/operations_api.dart';
import 'operations_widgets.dart';

/// Validates an optional phone field with the central normaliser.
String? optionalPhoneValidator(String? v) {
  if (v == null || v.trim().isEmpty) return null;
  return PhoneNumbers.normalize(v) == null ? 'Enter a valid phone number, e.g. 0772 123 456' : null;
}

String? requiredText(String? v, String what, {int max = 60}) {
  final t = v?.trim() ?? '';
  if (t.isEmpty) return 'Enter the $what';
  if (t.length > max) return 'Too long ($max characters maximum)';
  return null;
}

/// Controllers for the customer form, reused by "new customer" inside
/// vehicle registration.
class CustomerControllers {
  CustomerControllers([Customer? c])
      : name = TextEditingController(text: c?.fullName ?? ''),
        phone = TextEditingController(text: c?.phoneNumber ?? ''),
        altPhone = TextEditingController(text: c?.alternativePhone ?? ''),
        email = TextEditingController(text: c?.email ?? ''),
        address = TextEditingController(text: c?.address ?? ''),
        notes = TextEditingController(text: c?.notes ?? '');

  final TextEditingController name, phone, altPhone, email, address, notes;

  /// Values as typed (the server normalises and validates again).
  CustomerInput toInput() => CustomerInput(
        fullName: name.text.trim(),
        phoneNumber: phone.text.trim(),
        alternativePhone: altPhone.text.trim(),
        email: email.text.trim(),
        address: address.text.trim(),
        notes: notes.text.trim(),
      );

  void dispose() {
    for (final c in [name, phone, altPhone, email, address, notes]) {
      c.dispose();
    }
  }
}

class CustomerFields extends StatelessWidget {
  const CustomerFields({super.key, required this.controllers, this.compact = false});
  final CustomerControllers controllers;

  /// Name and phone only (quick registration at the counter).
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final c = controllers;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextFormField(
        key: const Key('customer-name-field'),
        controller: c.name,
        textCapitalization: TextCapitalization.words,
        decoration: const InputDecoration(labelText: 'Full name *'),
        validator: (v) {
          final t = v?.trim() ?? '';
          if (t.length < 2) return 'Enter the customer\'s name';
          return t.length > 80 ? 'The name is too long' : null;
        },
      ),
      const SizedBox(height: AppSpacing.sm),
      TextFormField(
        key: const Key('customer-phone-field'),
        controller: c.phone,
        keyboardType: TextInputType.phone,
        decoration: const InputDecoration(labelText: 'Phone number', hintText: '0772 123 456', prefixText: '🇺🇬 '),
        validator: optionalPhoneValidator,
      ),
      if (!compact) ...[
        const SizedBox(height: AppSpacing.sm),
        TextFormField(
          key: const Key('customer-alt-phone-field'),
          controller: c.altPhone,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(labelText: 'Alternative phone'),
          validator: optionalPhoneValidator,
        ),
        const SizedBox(height: AppSpacing.sm),
        TextFormField(
          key: const Key('customer-email-field'),
          controller: c.email,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'Email'),
          validator: Validators.email,
        ),
        const SizedBox(height: AppSpacing.sm),
        TextFormField(
          key: const Key('customer-address-field'),
          controller: c.address,
          decoration: const InputDecoration(labelText: 'Address'),
          validator: (v) => (v?.trim().length ?? 0) > 200 ? 'Too long (200 characters maximum)' : null,
        ),
        const SizedBox(height: AppSpacing.sm),
        TextFormField(
          key: const Key('customer-notes-field'),
          controller: c.notes,
          maxLines: 3,
          minLines: 1,
          decoration: const InputDecoration(labelText: 'Notes'),
          validator: (v) => (v?.trim().length ?? 0) > 500 ? 'Too long (500 characters maximum)' : null,
        ),
      ],
    ]);
  }
}

/// Searches existing customers and returns the chosen one.
Future<Customer?> showCustomerPicker(BuildContext context) => showModalBottomSheet<Customer>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: const _CustomerPicker(),
      ),
    );

class _CustomerPicker extends ConsumerStatefulWidget {
  const _CustomerPicker();

  @override
  ConsumerState<_CustomerPicker> createState() => _CustomerPickerState();
}

class _CustomerPickerState extends ConsumerState<_CustomerPicker> {
  List<Customer> _results = const [];
  bool _loading = false;
  int _req = 0;

  @override
  void initState() {
    super.initState();
    _search('');
  }

  Future<void> _search(String q) async {
    final id = ++_req;
    setState(() => _loading = true);
    try {
      final r = await ref.read(operationsRepositoryProvider).searchCustomers(q, status: RecordStatus.active);
      if (mounted && id == _req) setState(() => _results = r);
    } finally {
      if (mounted && id == _req) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.7,
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, AppSpacing.xs),
              child: TextField(
                key: const Key('customer-picker-search'),
                autofocus: true,
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Name, phone or customer ID'),
                onChanged: _search,
              ),
            ),
            if (_loading) const LinearProgressIndicator(),
            Expanded(
              child: _results.isEmpty && !_loading
                  ? const Center(child: Text('No matching active customers'))
                  : ListView(
                      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                      children: [
                        for (final c in _results)
                          CustomerTile(customer: c, onTap: () => Navigator.of(context).pop(c)),
                      ],
                    ),
            ),
          ]),
        ),
      );
}
