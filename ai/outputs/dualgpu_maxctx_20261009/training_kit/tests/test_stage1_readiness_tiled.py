"""Reject forged tiled-MLP success flags and incomplete numerical evidence."""
import copy
import hashlib
import unittest

from counseling_pipeline import stage1_readiness as gate


def metric(*, elements=10752 * 5376, zero=False):
    return {'elements': elements, 'all_finite': True, 'passed': True,
            'maximum_relative_l2_error': .02, 'minimum_cosine': .999,
            'reference_norm': 0.0 if zero else 1.0, 'observed_norm': 0.0 if zero else 1.0,
            'relative_l2_error': 0.0, 'cosine': 1.0, 'both_exactly_zero': zero}


class TiledReadinessTests(unittest.TestCase):
    def setUp(self):
        self.bindings = {key: hashlib.sha256(key.encode()).hexdigest() for key in gate.BINDING_KEYS}
        self.evidence = {
            'criterion': 'tiled_mlp_bf16_v1', 'passed': True, 'optimizer_steps': 0,
            'patched_language_mlp_count': 60, 'synthetic_inputs': True,
            'adapter_hash_before': 'a' * 64, 'adapter_hash_after': 'a' * 64, 'weights_unchanged': True,
            'modules': [{'module': f'base_model.model.language_model.layers.{layer}.mlp',
                         'device': f'cuda:{index}', 'passed': True,
                         'input_shape': [1, 10752, 5376], 'expected_tiles': 2,
                         'observed_tile_calls': [
                             {'shape': [1, 5376, 5376], 'grad_enabled': enabled}
                             for enabled in (False, False, True, True)],
                         'metrics': {'output': metric(), 'hidden_gradient': metric(),
                                     'lora_gradients': {
                                         f'{projection}.lora_{part}.default.weight': metric(elements=43008, zero=part == 'A')
                                         for projection in ('gate_proj', 'up_proj', 'down_proj') for part in ('A', 'B')}}}
                        for index, layer in enumerate((0, 30))],
        }

    def validate(self, evidence=None):
        report = {'schema_version': gate.SCHEMA_VERSION, 'mode': 'preparation', 'status': 'passed',
                  'optimizer_steps': 0, 'bindings': self.bindings, 'checks': [
                      {'name': 'tiled_mlp_equivalence', 'passed': True,
                       'evidence': self.evidence if evidence is None else evidence}]}
        return gate.validate_report(report, expected_bindings=self.bindings,
                                    required_checks=('tiled_mlp_equivalence',),
                                    expected_check_contracts={'tiled_mlp_equivalence': 'tiled_mlp_bf16_v1'})

    def test_complete_evidence_and_exact_zero_lora_gradients_pass_without_mutation(self):
        before = copy.deepcopy(self.evidence)
        self.validate()
        self.assertEqual(self.evidence, before)

    def test_placeholder_passed_flags_do_not_supply_missing_evidence(self):
        for evidence in ({'passed': True}, {'criterion': 'tiled_mlp_bf16_v1', 'passed': True}):
            with self.subTest(evidence=evidence), self.assertRaises(gate.ReadinessError):
                self.validate(evidence)
        for key in self.evidence:
            with self.subTest(missing=key), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence)
                del bad[key]
                self.validate(bad)

    def test_scope_counts_hashes_and_booleans_are_exact(self):
        for field, value in (('optimizer_steps', True), ('optimizer_steps', 1),
                             ('patched_language_mlp_count', 60.0), ('patched_language_mlp_count', 59),
                             ('synthetic_inputs', 1), ('passed', 1), ('weights_unchanged', 1),
                             ('adapter_hash_before', 'placeholder'), ('adapter_hash_after', 'b' * 64)):
            with self.subTest(field=field, value=value), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad[field] = value
                self.validate(bad)

    def test_both_devices_and_distinct_real_language_layer_names_are_required(self):
        for field, value in (('device', 'cuda:0'), ('device', 'cpu'), ('device', []),
                             ('module', self.evidence['modules'][0]['module']), ('module', 'placeholder'),
                             ('module', 'language_model.layers.60.mlp'), ('module', 'language_model.layers.00.mlp')):
            with self.subTest(field=field, value=value), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad['modules'][1][field] = value
                self.validate(bad)
        for modules in ([self.evidence['modules'][0]], [None, None], None):
            with self.subTest(modules=modules), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad['modules'] = modules
                self.validate(bad)

    def test_actual_two_tile_forward_and_backward_calls_cannot_be_forged_by_counts(self):
        for field, value in (('expected_tiles', 2.0), ('expected_tiles', 1),
                             ('input_shape', [True, 10752, 5376]), ('input_shape', [1, 5376, 5376]),
                             ('observed_tile_calls', []), ('passed', 1)):
            with self.subTest(field=field, value=value), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad['modules'][0][field] = value
                self.validate(bad)
        for mutate in (lambda calls: calls.pop(),
                       lambda calls: calls[0].update(grad_enabled=0),
                       lambda calls: calls[0].update(shape=[1, 5376.0, 5376]),
                       lambda calls: calls[2].update(grad_enabled=False)):
            with self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence)
                mutate(bad['modules'][0]['observed_tile_calls'])
                self.validate(bad)

    def test_six_exact_lora_names_are_required(self):
        for mutate in (lambda gradients: gradients.pop('gate_proj.lora_A.default.weight'),
                       lambda gradients: gradients.update(placeholder=metric()),
                       lambda gradients: gradients.update({'gate_proj.lora_B.default.weight': None})):
            with self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence)
                mutate(bad['modules'][0]['metrics']['lora_gradients'])
                self.validate(bad)

    def test_invalid_nested_shapes_raise_readiness_errors(self):
        for field, value in (('metrics', None), ('metrics', [])):
            with self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad['modules'][0][field] = value
                self.validate(bad)
        for field in ('output', 'hidden_gradient', 'lora_gradients'):
            with self.subTest(field=field), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad['modules'][0]['metrics'][field] = None
                self.validate(bad)

    def test_numerical_bounds_remain_strict_despite_all_passed_flags(self):
        for field, value in (('relative_l2_error', .020001), ('relative_l2_error', -.001),
                             ('cosine', .998999), ('cosine', 1.1), ('maximum_relative_l2_error', .03),
                             ('minimum_cosine', .99), ('reference_norm', -1), ('observed_norm', 0),
                             ('reference_norm', True), ('relative_l2_error', float('nan')),
                             ('all_finite', 1), ('passed', 1), ('elements', True), ('elements', 1)):
            for tensor in ('output', 'hidden_gradient'):
                with self.subTest(field=field, value=value, tensor=tensor), self.assertRaises(gate.ReadinessError):
                    bad = copy.deepcopy(self.evidence); bad['modules'][0]['metrics'][tensor][field] = value
                    self.validate(bad)

    def test_every_lora_tensor_is_numerically_checked(self):
        for name in self.evidence['modules'][0]['metrics']['lora_gradients']:
            with self.subTest(name=name), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence)
                bad['modules'][0]['metrics']['lora_gradients'][name]['relative_l2_error'] = .03
                self.validate(bad)

    def test_exact_relative_error_limit_passes(self):
        self.evidence['modules'][0]['metrics']['output'].update(observed_norm=1.02, relative_l2_error=.02)
        self.validate()

    def test_norm_and_cosine_cannot_contradict_the_reported_error(self):
        for values in ({'observed_norm': 2.0}, {'cosine': .999}, {'relative_l2_error': .01}):
            with self.subTest(values=values), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad['modules'][0]['metrics']['output'].update(values)
                self.validate(bad)

    def test_zero_exception_applies_only_to_exact_zero_lora_pairs(self):
        key = 'gate_proj.lora_A.default.weight'
        for values in ({'observed_norm': 1e-20}, {'relative_l2_error': .001},
                       {'cosine': .9999}, {'both_exactly_zero': 1}, {'both_exactly_zero': False}):
            with self.subTest(values=values), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence)
                bad['modules'][0]['metrics']['lora_gradients'][key].update(values)
                self.validate(bad)
        for tensor in ('output', 'hidden_gradient'):
            with self.subTest(tensor=tensor), self.assertRaises(gate.ReadinessError):
                bad = copy.deepcopy(self.evidence); bad['modules'][0]['metrics'][tensor] = metric(zero=True)
                self.validate(bad)
        with self.assertRaises(gate.ReadinessError):
            bad = copy.deepcopy(self.evidence)
            bad['modules'][0]['metrics']['lora_gradients'] = {
                name: metric(elements=43008, zero=True) for name in bad['modules'][0]['metrics']['lora_gradients']}
            self.validate(bad)


if __name__ == '__main__':
    unittest.main()
