import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// cropper.js needs layout APIs that jsdom lacks. The contract under test is
// the dialog's wiring: it must build a 1:1 cropper over the picked image, and
// "Use this photo" must hand the caller a JPEG data URL, or stop on error.
vi.mock("cropperjs", () => {
  const instances = [];
  class FakeCropper {
    constructor(img, options) {
      this.img = img;
      this.options = options;
      this.destroyed = false;
      instances.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
    getCroppedCanvas() {
      return {
        toDataURL: () => "data:image/jpeg;base64,QUJD", // "ABC"
      };
    }
  }
  return { default: FakeCropper, __instances: instances };
});
vi.mock("cropperjs/dist/cropper.css", () => ({}));

import * as cropperNamespace from "cropperjs";
import ImageCropDialog from "./ImageCropDialog.jsx";

const cropperInstances = () => cropperNamespace.__instances ?? [];

function renderDialog(props = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(<ImageCropDialog onSave={onSave} onCancel={onCancel} {...props} />);
  return { onSave, onCancel };
}

function pickPhoto(file) {
  const input = document.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [file] } });
}

const jpegFile = () => new File(["jpeg-bytes"], "photo.jpg", { type: "image/jpeg" });

describe("ImageCropDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the operator to drag the square — there is no zoom slider", () => {
    renderDialog();
    expect(screen.getByText(/Drag and resize the square/)).toBeInTheDocument();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("opens the 1:1 cropper on the picked photo", async () => {
    renderDialog();
    pickPhoto(jpegFile());
    await waitFor(() => expect(cropperInstances().length).toBe(1));
    expect(cropperInstances()[0].options.aspectRatio).toBe(1);
    expect(cropperInstances()[0].options.cropBoxResizable).toBe(true);
  });

  it("rebuilds the cropper when a different photo is chosen", async () => {
    renderDialog();
    pickPhoto(jpegFile());
    await waitFor(() => expect(cropperInstances().length).toBe(1));
    pickPhoto(new File(["more"], "other.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(cropperInstances().length).toBe(2));
    expect(cropperInstances()[0].destroyed).toBe(true);
  });

  it("restores from a seed image instead of starting empty", async () => {
    renderDialog({ seed: "https://example.test/current.jpg" });
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Use this photo" })).toBeEnabled();
  });

  it("hands onSave a JPEG data URL when confirmed", async () => {
    const { onSave } = renderDialog({ seed: "https://example.test/current.jpg" });
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0][0];
    expect(arg.mime).toBe("image/jpeg");
    expect(arg.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("blocks non-image picks with an alert instead of crashing", async () => {
    renderDialog();
    pickPhoto(new File(["not-an-image"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/image file/i);
  });

  it("cancel raises onCancel, not onSave", () => {
    const { onSave, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
