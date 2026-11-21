# About me (notes for calls)

I'm Tomás Reyes, a machine learning engineer at Medley Health in Austin. I've been there four years and I build our
clinical note summarization models.

## How I use the cloud

- I use AWS for almost everything.
- For fine-tuning I spin up spot p4d instances (8x A100) through SageMaker training jobs. A run takes 6 to 10 hours.
- I fine-tune Llama 3 8B with LoRA on de-identified clinical notes.
- For quick reinforcement learning experiments I use single g5 instances (A10G), also on spot.
- I checkpoint to S3 every 30 minutes because spot instances get reclaimed.
- Infrastructure is in Terraform, and training jobs are launched from GitHub Actions.

## Before Medley

- Two years as a data engineer at Brightline Logistics, building Spark pipelines on EMR.
- MS in Computer Science, UT Austin, 2019.
