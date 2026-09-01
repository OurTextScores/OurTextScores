"""Inference-only form of the E2/E4 CamVid U-Net checkpoint wrapper."""

import segmentation_models_pytorch as smp
import torch
from torch import nn


class CamVidModel(nn.Module):
    """Matches the training module's state-dict names without Lightning hooks."""

    def __init__(
        self,
        arch: str = "Unet",
        encoder_name: str = "resnet18",
        in_channels: int = 3,
        out_classes: int = 0,
        skip_weights_download: bool = False,
        **kwargs,
    ) -> None:
        super().__init__()
        self.model = smp.create_model(
            arch,
            encoder_name=encoder_name,
            encoder_weights=None if skip_weights_download else "imagenet",
            in_channels=in_channels,
            classes=out_classes,
            **kwargs,
        )
        params = smp.encoders.get_preprocessing_params(encoder_name)
        self.number_of_classes = out_classes
        self.register_buffer("std", torch.tensor(params["std"]).view(1, 3, 1, 1))
        self.register_buffer("mean", torch.tensor(params["mean"]).view(1, 3, 1, 1))

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        return self.model((image - self.mean) / self.std)
