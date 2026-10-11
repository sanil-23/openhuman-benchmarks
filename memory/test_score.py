import unittest
from score import score

class OfficialScoringTests(unittest.TestCase):
    def loco(self, answer, prediction, category):
        return score({'dataset': 'locomo', 'answer': prediction,
                      'reference': {'answer': answer, 'category': category, 'evidence': []}})['score']

    def test_open_domain_uses_first_answer_before_semicolon(self):
        self.assertEqual(self.loco('psychology; social work', 'psychology', 3), 1)

    def test_multihop_requires_all_comma_separated_answers(self):
        self.assertEqual(self.loco('tennis, swimming', 'tennis', 1), 0.5)

    def test_adversarial_requires_official_abstention_phrasing(self):
        self.assertEqual(self.loco('', 'no information available', 5), 1)
        self.assertEqual(self.loco('', 'unknown', 5), 0)

    def test_temporal_judge_prompt_keeps_off_by_one_exception(self):
        result = score({'dataset': 'longmemeval', 'question': 'How many days?', 'answer': '19',
                        'reference': {'type': 'temporal-reasoning', 'answer': '18', 'abstention': False}})
        self.assertIn('off-by-one', result['prompt'])

if __name__ == '__main__':
    unittest.main()
