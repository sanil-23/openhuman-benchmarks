"""Download pinned public datasets and official scorer sources."""
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent / "source"
URLS = {
    "LONGMEMEVAL-LICENSE": "https://raw.githubusercontent.com/xiaowu0162/LongMemEval/9e0b455f4ef0e2ab8f2e582289761153549043fc/LICENSE",
    "LOCOMO-LICENSE": "https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt",
    "longmemeval.json": "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/2ec2a557f339b6c0369619b1ed5793734cc87533/longmemeval_s",
    "locomo.json": "https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json",
    "lme-evaluate.py": "https://raw.githubusercontent.com/xiaowu0162/LongMemEval/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py",
    "locomo-evaluate.py": "https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py",
}

if __name__ == "__main__":
    ROOT.mkdir(exist_ok=True)
    for name, url in URLS.items():
        target = ROOT/name
        if not target.exists():
            temporary = ROOT/(name+'.part')
            urllib.request.urlretrieve(url, temporary)
            temporary.rename(target)
        print(name, target.stat().st_size)
