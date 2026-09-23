/** Both assets load together so changing theme never flashes the wrong logo. */
export function BrandLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`preview-brand-logo ${className}`} role="img" aria-label="全域智能 Omni-Intelligence">
      <img className="preview-brand-light" src={`${import.meta.env.BASE_URL}branding/omni-intelligence-light.png`} alt="" aria-hidden="true" />
      <img className="preview-brand-dark" src={`${import.meta.env.BASE_URL}branding/omni-intelligence-dark.png`} alt="" aria-hidden="true" />
    </span>
  )
}
