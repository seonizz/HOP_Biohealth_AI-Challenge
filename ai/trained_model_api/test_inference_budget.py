"""CPU-only checks for serving reservations; no model or network access."""

import unittest

from inference_budget import safe_budget_error_message, validate_inference_budget


class InferenceBudgetTests(unittest.TestCase):
    def test_inclusive_input_output_and_context_boundaries(self):
        for input_tokens, output_tokens in ((1, 1), (61440, 8192), (65536, 4096)):
            with self.subTest(input_tokens=input_tokens, output_tokens=output_tokens):
                self.assertIsNone(validate_inference_budget(input_tokens, output_tokens))

    def test_only_the_requested_output_is_reserved(self):
        for input_tokens in (4097, 65536):
            with self.subTest(input_tokens=input_tokens):
                self.assertIsNone(validate_inference_budget(input_tokens, 1800))

    def test_combined_budget_excess_has_exact_source_free_message(self):
        for counts, message in (
            ((61441, 8192), "Prompt (61441) plus max_tokens (8192) exceeds the 69632-token context budget; no text was truncated"),
            ((65536, 4097), "Prompt (65536) plus max_tokens (4097) exceeds the 69632-token context budget; no text was truncated"),
        ):
            with self.subTest(counts=counts), self.assertRaises(ValueError) as raised:
                validate_inference_budget(*counts)
            self.assertEqual(str(raised.exception), message)

    def test_input_ceiling_applies_even_when_total_fits(self):
        with self.assertRaises(ValueError) as raised:
            validate_inference_budget(65537, 1)
        self.assertEqual(str(raised.exception),
            "Prompt (65537) exceeds the 65536-token input budget; no text was truncated")

    def test_output_ceiling_applies_even_when_total_fits(self):
        with self.assertRaises(ValueError) as raised:
            validate_inference_budget(1, 8193)
        self.assertEqual(str(raised.exception), "max_tokens must be between 1 and 8192")

    def test_both_counts_require_strict_positive_integers(self):
        class IntegerSubclass(int):
            pass

        invalid = (0, -1, True, False, 1.0, "1", None, [], {}, IntegerSubclass(1))
        for value in invalid:
            with self.subTest(value=value, field="input"):
                with self.assertRaises(ValueError) as raised:
                    validate_inference_budget(value, 1)
                self.assertEqual(str(raised.exception), "input_tokens must be a positive integer")
            with self.subTest(value=value, field="output"):
                with self.assertRaises(ValueError) as raised:
                    validate_inference_budget(1, value)
                self.assertEqual(str(raised.exception), "max_tokens must be a positive integer")

    def test_invalid_objects_are_never_rendered_in_errors(self):
        class PrivateValue:
            def __str__(self):
                raise AssertionError("Invalid values must not be rendered")

            __repr__ = __str__

        with self.assertRaisesRegex(ValueError, "^input_tokens must be a positive integer$"):
            validate_inference_budget(PrivateValue(), 1)
        with self.assertRaisesRegex(ValueError, "^max_tokens must be a positive integer$"):
            validate_inference_budget(1, PrivateValue())


class SafeBudgetErrorTests(unittest.TestCase):
    MESSAGES = (
        "Prompt (65537) exceeds the 65536-token input budget; no text was truncated",
        "Prompt (61441) plus max_tokens (8192) exceeds the 69632-token context budget; no text was truncated",
        "Prompt exceeds the input budget; no text was truncated",
        "Prompt exceeds the v11 input budget; no text was truncated",
    )

    def test_only_complete_current_and_legacy_budget_messages_are_returned(self):
        for message in self.MESSAGES:
            with self.subTest(message=message):
                self.assertIs(safe_budget_error_message(message), message)

    def test_generated_budget_errors_pass_without_changing_the_message(self):
        for counts in ((65537, 1), (61441, 8192), (65536, 4097)):
            with self.subTest(counts=counts), self.assertRaises(ValueError) as raised:
                validate_inference_budget(*counts)
            message = str(raised.exception)
            self.assertEqual(safe_budget_error_message(message), message)

    def test_prefix_suffix_whitespace_and_source_additions_are_rejected(self):
        for message in self.MESSAGES:
            for extra in ("private source", " ", "\n", "\r\n", "\t", "\x00"):
                for altered in (extra + message, message + extra):
                    with self.subTest(message=message, extra=extra):
                        self.assertIsNone(safe_budget_error_message(altered))

    def test_other_errors_and_changed_budget_syntax_are_not_forwarded(self):
        for message in (
            "GPU worker rejected the request: invalid_request",
            "Message contains reserved model control tokens",
            "GPU generation failed",
            "max_tokens must be between 1 and 8192",
            self.MESSAGES[0].replace("(65537)", "(private source)"),
            self.MESSAGES[0].replace("(65537)", "(６５５３７)"),
            self.MESSAGES[0].replace("(65537)", "(0)"),
            self.MESSAGES[0].replace("(65537)", "(-1)"),
            self.MESSAGES[0].replace("65536-token", "131072-token"),
            self.MESSAGES[1].replace("69632-token", "131072-token"),
            self.MESSAGES[1].replace("(8192)", "(8192.0)"),
            "",
        ):
            with self.subTest(message=message):
                self.assertIsNone(safe_budget_error_message(message))

    def test_non_strings_are_rejected_without_rendering_them(self):
        class PrivateValue:
            def __str__(self):
                raise AssertionError("Invalid values must not be rendered")

            __repr__ = __str__

        for value in (None, True, 8193, 8193.0, [], {}, self.MESSAGES[0].encode(), PrivateValue()):
            self.assertIsNone(safe_budget_error_message(value))

    def test_string_subclasses_follow_the_string_contract(self):
        class Message(str):
            pass

        message = Message(self.MESSAGES[0])
        self.assertIs(safe_budget_error_message(message), message)


if __name__ == "__main__":
    unittest.main()
