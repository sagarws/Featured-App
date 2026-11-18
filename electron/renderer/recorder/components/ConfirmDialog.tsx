import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material'

const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) => (
  <Dialog open={open} onClose={onCancel} maxWidth='xs' fullWidth>
    <DialogTitle>{title}</DialogTitle>
    <DialogContent>
      <DialogContentText>{message}</DialogContentText>
    </DialogContent>
    <DialogActions>
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant='contained' color='error' onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </DialogActions>
  </Dialog>
)

export default ConfirmDialog
